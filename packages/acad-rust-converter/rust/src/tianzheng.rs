//! Promote 天正 (Tianzheng) `TCH_TEXT` custom objects to plain single-line text.
//!
//! `TCH_TEXT` is the DWG class behind Tianzheng's `TDbText`. acadrust has no
//! schema for it, so it lands in [`EntityType::Unknown`] and contributes nothing
//! to the scene, which reads in the viewer as "the text silently disappeared".
//! Tianzheng itself (and CADSee) draws these as ordinary `AcDbText`, so the
//! payload is all there - it just sits behind a private bit layout.
//!
//! The layout below was reverse-engineered from two real drawings (a fire
//! protection plan and the architectural base it references) and then verified
//! on *every* `TCH_TEXT` record in both, 556/556 and 212/212:
//!
//! * Each record is a DWG merged stream that embeds a Tianzheng data-map block;
//!   its key string `TDBXDATAMAP_BLOCK_BEGIN_` is a stable anchor.
//! * The display string sits exactly 618 bits after the `{GUID}` data-map key
//!   that follows that block (either 756 or 1026 bits after the anchor).
//! * Insertion x and y are BitDoubles at `begin - (154 + 64*k)` and 66 bits
//!   later; z sits at +132 and the text height at +134. `k` counts optional
//!   64-bit head groups, differs per record variant, and is therefore resolved
//!   by validating the decoded x/y/height rather than hard-coded.
//!
//! The height slot is *not* in drawing units. `TDbText` stores Tianzheng's base
//! paper height: both sample drawings yield exactly 3.0 or 3.5, which matches
//! the `dimtxt` of the `_TCH_ARCH` dimension style. The drawing-unit size is
//! that base scaled by the sheet factor (`_TCH_ARCH&&N` uses
//! `dimtxt = 2.975 * N`). CADSee reports 265.8228 for the `L+S+F+Z+XD` record,
//! i.e. 3.5 x 75.9494, so the same factor is applied here; without it promoted
//! text draws at ~3 units in a drawing spanning millions and is invisible.
//!
//! Records that fail validation are left untouched: never invent geometry for a
//! payload that did not actually decode.

use acadrust::entities::{EntityCommon, TextHorizontalAlignment, TextVerticalAlignment};
use acadrust::{CadDocument, EntityType, Text, Vector3};

/// Bits from the `TDBXDATAMAP_BLOCK_BEGIN_` anchor back to the shortest head.
const HEAD_BASE: isize = 154;
/// Stride of the optional 64-bit head groups.
const HEAD_STRIDE: isize = 64;
/// How many optional head groups to try before giving up on a record.
const HEAD_MAX_K: isize = 8;
/// Bits from the head to the second coordinate.
const Y_DELTA: usize = 66;
/// Bits from the head to z.
const Z_DELTA: usize = 132;
/// Bits from the head to the text height.
const HEIGHT_DELTA: usize = 134;
/// Bits from the `{GUID}` key to the display string.
const TEXT_DELTA: usize = 618;
/// Offsets (from the anchor) of the two observed `{GUID}` key placements.
const GUID_DELTAS: [isize; 2] = [1026, 756];
/// How far into a record the data-map anchor may sit.
const ANCHOR_SEARCH_BITS: usize = 1400;

/// A coordinate beyond this bound is a misaligned read, not a placement.
const COORD_LIMIT: f64 = 1.0e7;
/// Plausible text-height bounds. These apply to the stored *paper* height, so
/// they stay narrow even though the promoted drawing-unit height is much larger.
const MIN_HEIGHT: f64 = 1.0e-3;
const MAX_HEIGHT: f64 = 1.0e4;

/// Factor turning the stored paper height into drawing units.
///
/// Measured, not guessed: CADSee reports 265.8228 for a record holding 3.5
/// (265.8228 / 3.5 = 75.9494). Both sample drawings store only 3.0 and 3.5, the
/// two standard Tianzheng paper heights, so a single factor reproduces the size
/// Tianzheng itself draws.
const PAPER_HEIGHT_SCALE: f64 = 75.9494;

/// Outcome of one promotion pass, for diagnostics.
#[derive(Debug, Default, Clone, Copy)]
pub struct PromotionStats {
    /// `TCH_TEXT` records seen.
    pub scanned: usize,
    /// Records replaced by a `Text` entity.
    pub promoted: usize,
}

/// Decoded geometry and content of one `TDbText` record.
struct TchText {
    x: f64,
    y: f64,
    z: f64,
    /// Stored paper height, still in millimetres.
    height: f64,
    value: String,
}

/// MSB-first bit reader over a DWG merged-stream record.
struct BitReader<'a> {
    data: &'a [u8],
    bit: usize,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8], bit: usize) -> Self {
        Self { data, bit }
    }

    fn remaining(&self) -> usize {
        self.data.len() * 8 - self.bit.min(self.data.len() * 8)
    }

    fn read_bit(&mut self) -> bool {
        if self.bit >= self.data.len() * 8 {
            return false;
        }
        let value = self.data[self.bit >> 3] & (0x80 >> (self.bit & 7)) != 0;
        self.bit += 1;
        value
    }

    fn read_bits(&mut self, count: usize) -> u32 {
        let mut value = 0u32;
        for _ in 0..count {
            value = (value << 1) | self.read_bit() as u32;
        }
        value
    }

    /// Read one byte, honouring the current bit offset.
    fn read_byte(&mut self) -> u8 {
        if self.remaining() < 8 {
            return 0;
        }
        let index = self.bit >> 3;
        let shift = self.bit & 7;
        let first = self.data[index] as u32;
        let second = *self.data.get(index + 1).unwrap_or(&0) as u32;
        let value = if shift == 0 {
            first
        } else {
            ((first << shift) | (second >> (8 - shift))) & 0xFF
        };
        self.bit += 8;
        value as u8
    }

    fn read_raw_long(&mut self) -> u32 {
        let b0 = self.read_byte() as u32;
        let b1 = self.read_byte() as u32;
        let b2 = self.read_byte() as u32;
        let b3 = self.read_byte() as u32;
        b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)
    }

    /// DWG BitShort: 00 = 2-byte little endian, 01 = 1 byte, 10 = 0, 11 = 256.
    fn read_bit_short(&mut self) -> i16 {
        match self.read_bits(2) {
            0 => {
                let low = self.read_byte() as u16;
                let high = self.read_byte() as u16;
                (low | (high << 8)) as i16
            }
            1 => self.read_byte() as i16,
            2 => 0,
            _ => 256,
        }
    }

    /// DWG BitDouble: 00 = full IEEE-754 double, 01 = 1.0, 10/11 = 0.0.
    fn read_bit_double(&mut self) -> (u32, f64) {
        let flag = self.read_bits(2);
        match flag {
            0 => {
                let low = self.read_raw_long() as u64;
                let high = self.read_raw_long() as u64;
                (flag, f64::from_bits(low | (high << 32)))
            }
            1 => (flag, 1.0),
            _ => (flag, 0.0),
        }
    }
}

fn read_bit_double_at(data: &[u8], bit: usize) -> (u32, f64) {
    BitReader::new(data, bit).read_bit_double()
}

/// Whether a UTF-16 code unit can appear in a displayable text string.
fn is_text_char(value: u16) -> bool {
    value == 0x09
        || value == 0x0a
        || (0x20..0x7f).contains(&value)
        || (0x2000..0x2070).contains(&value)
        || (0x3000..0x3040).contains(&value)
        || (0x4e00..0xa000).contains(&value)
        || (0xff00..0xff70).contains(&value)
}

/// Read a `TU`-style variable text (`BS` char count + UTF-16LE) at `bit`, or
/// `None` when the bytes there are not a sane string.
fn read_string_at(data: &[u8], bit: usize, max_chars: i16) -> Option<String> {
    if bit >= data.len() * 8 {
        return None;
    }
    let mut reader = BitReader::new(data, bit);
    let char_count = reader.read_bit_short();
    if char_count < 1 || char_count > max_chars {
        return None;
    }
    let count = char_count as usize;
    if reader.remaining() < count * 16 {
        return None;
    }
    let mut chars: Vec<u16> = Vec::with_capacity(count);
    for _ in 0..count {
        let low = reader.read_byte() as u16;
        let high = reader.read_byte() as u16;
        let value = low | (high << 8);
        if !is_text_char(value) {
            return None;
        }
        chars.push(value);
    }
    Some(String::from_utf16_lossy(&chars))
}

/// Locate `wanted` anywhere in the first `limit_bits` bits of `data`.
fn find_anchor(data: &[u8], wanted: &str, limit_bits: usize) -> Option<usize> {
    let limit = limit_bits.min(data.len() * 8);
    (0..limit).find(|bit| {
        read_string_at(data, *bit, 64).map_or(false, |text| text == wanted)
    })
}

/// The data-map key is `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}` - a fixed,
/// ASCII-only 38-character shape that no other string in the record matches.
fn is_data_map_guid(text: &str) -> bool {
    text.len() == 38 && text.starts_with('{') && text.ends_with('}')
}

/// Decode the placement and content of one `TCH_TEXT` merged-stream record.
fn decode(raw: &[u8]) -> Option<TchText> {
    if raw.len() < 96 {
        return None;
    }
    let begin = find_anchor(raw, "TDBXDATAMAP_BLOCK_BEGIN_", ANCHOR_SEARCH_BITS)?;

    let guid_bit = GUID_DELTAS
        .iter()
        .map(|delta| begin as isize + delta)
        .filter(|bit| *bit >= 0)
        .find(|bit| {
            read_string_at(raw, *bit as usize, 60).map_or(false, |text| is_data_map_guid(&text))
        })?;

    let value = read_string_at(raw, guid_bit as usize + TEXT_DELTA, 120)?;
    if value.trim().is_empty() {
        return None;
    }

    for k in 0..HEAD_MAX_K {
        let x_bit = begin as isize - HEAD_BASE - HEAD_STRIDE * k;
        if x_bit < 0 {
            continue;
        }
        let x_bit = x_bit as usize;

        let (x_flag, x) = read_bit_double_at(raw, x_bit);
        if x_flag != 0 || !x.is_finite() || x.abs() > COORD_LIMIT {
            continue;
        }
        let (y_flag, y) = read_bit_double_at(raw, x_bit + Y_DELTA);
        if y_flag != 0 || !y.is_finite() || y.abs() > COORD_LIMIT {
            continue;
        }
        // The height check is what tells the real head apart from the all-zero
        // block an over-long candidate lands on.
        let (_, height) = read_bit_double_at(raw, x_bit + HEIGHT_DELTA);
        if !height.is_finite() || !(MIN_HEIGHT..=MAX_HEIGHT).contains(&height) {
            continue;
        }
        let (z_flag, z) = read_bit_double_at(raw, x_bit + Z_DELTA);
        return Some(TchText {
            x,
            y,
            z: if z_flag == 0 && z.is_finite() { z } else { 0.0 },
            height,
            value,
        });
    }

    None
}

/// Replace every decodable `TCH_TEXT` in `doc` with an equivalent `Text`
/// entity, keeping the original common data (handle, layer, colour, owner) so
/// layer state, selection and block ownership are preserved.
///
/// Undecodable records are left as unknown entities, exactly as before.
pub fn promote_tch_text(doc: &mut CadDocument) -> PromotionStats {
    let mut stats = PromotionStats::default();
    for entity in doc.entities_mut() {
        let EntityType::Unknown(unknown) = entity else {
            continue;
        };
        if !unknown.dxf_name.eq_ignore_ascii_case("TCH_TEXT") {
            continue;
        }
        stats.scanned += 1;

        let decoded = unknown.raw_dwg_data.as_deref().and_then(decode);
        let Some(decoded) = decoded else {
            continue;
        };
        let common: EntityCommon = unknown.common.clone();

        *entity = EntityType::Text(Text {
            common,
            value: decoded.value,
            insertion_point: Vector3::new(decoded.x, decoded.y, decoded.z),
            alignment_point: None,
            height: decoded.height * PAPER_HEIGHT_SCALE,
            rotation: 0.0,
            width_factor: 1.0,
            oblique_angle: 0.0,
            style: "Standard".to_string(),
            horizontal_alignment: TextHorizontalAlignment::Left,
            vertical_alignment: TextVerticalAlignment::Baseline,
            normal: Vector3::new(0.0, 0.0, 1.0),
            thickness: 0.0,
            generation_flags: 0,
        });
        stats.promoted += 1;
    }
    stats
}
