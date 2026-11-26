//! Temporary native probe: hunt for a stable geometry layout inside Tianzheng
//! `TCH_TEXT` raw records.
//!
//! Strategy: decode three consecutive BitDoubles at every bit offset of every
//! instance, then keep only offsets that yield drawing-scale coordinates in a
//! majority of instances. A fixed field position across hundreds of instances
//! is strong evidence for the insertion point.
//!
//! Also reports the bit offset where the record's longest UTF-16 string starts,
//! so the private field block can be measured relative to the string stream.

use acadrust::{CadDocument, DwgReader, EntityType};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

struct Bits<'a> {
    data: &'a [u8],
    bit: usize,
}

impl<'a> Bits<'a> {
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
    fn read_bit_double(&mut self) -> f64 {
        match self.read_bits(2) {
            0 => {
                let low = self.read_raw_long() as u64;
                let high = self.read_raw_long() as u64;
                f64::from_bits(low | (high << 32))
            }
            1 => 1.0,
            _ => 0.0,
        }
    }
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
    /// Raw 8-byte IEEE double (RD type), still honoring bit alignment.
    fn read_raw_double(&mut self) -> f64 {
        let b0 = self.read_byte() as u64;
        let b1 = self.read_byte() as u64;
        let b2 = self.read_byte() as u64;
        let b3 = self.read_byte() as u64;
        let b4 = self.read_byte() as u64;
        let b5 = self.read_byte() as u64;
        let b6 = self.read_byte() as u64;
        let b7 = self.read_byte() as u64;
        f64::from_bits(b0 | (b1 << 8) | (b2 << 16) | (b3 << 24) | (b4 << 32) | (b5 << 40) | (b6 << 48) | (b7 << 56))
    }
}

fn is_text_char(value: u16) -> bool {
    value == 0x09
        || value == 0x0a
        || (0x20..0x7f).contains(&value)
        || (0x2000..0x2070).contains(&value)
        || (0x3000..0x3040).contains(&value)
        || (0x4e00..0xa000).contains(&value)
        || (0xff00..0xff70).contains(&value)
}

/// Decodes `BS count + UTF-16LE` at `bit`; returns the decoded text when every
/// code unit is a printable CAD character.
fn try_string(data: &[u8], bit: usize) -> Option<String> {
    let mut reader = Bits::new(data, bit);
    let char_count = reader.read_bit_short();
    if !(2..=80).contains(&char_count) {
        return None;
    }
    let count = char_count as usize;
    if reader.remaining() < count * 16 {
        return None;
    }
    let mut chars: Vec<u16> = Vec::with_capacity(count);
    let mut has_cjk = false;
    for _ in 0..count {
        let low = reader.read_byte() as u16;
        let high = reader.read_byte() as u16;
        let value = low | (high << 8);
        if !is_text_char(value) {
            return None;
        }
        if (0x4e00..0xa000).contains(&value) {
            has_cjk = true;
        }
        chars.push(value);
    }
    if !has_cjk && count < 4 {
        return None;
    }
    Some(String::from_utf16_lossy(&chars))
}

#[derive(Default)]
struct Slot {
    hits: usize,
    x_min: f64,
    x_max: f64,
    y_min: f64,
    y_max: f64,
    z_min: f64,
    z_max: f64,
    samples: Vec<String>,
}

impl Slot {
    fn record(&mut self, handle: u64, x: f64, y: f64, z: f64) {
        if self.hits == 0 {
            self.x_min = x;
            self.x_max = x;
            self.y_min = y;
            self.y_max = y;
            self.z_min = z;
            self.z_max = z;
        } else {
            self.x_min = self.x_min.min(x);
            self.x_max = self.x_max.max(x);
            self.y_min = self.y_min.min(y);
            self.y_max = self.y_max.max(y);
            self.z_min = self.z_min.min(z);
            self.z_max = self.z_max.max(z);
        }
        self.hits += 1;
        if self.samples.len() < 6 {
            self.samples
                .push(format!("{handle}: ({x:.3}, {y:.3}, {z:.3})"));
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: tch_layout <dwg> [out]");
    let out_path = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "tch-layout.txt".to_string());
    let doc: CadDocument = DwgReader::from_file(Path::new(&path))?.read()?;

    let mut records: Vec<(u64, &[u8])> = Vec::new();
    let mut len_hist: BTreeMap<usize, usize> = BTreeMap::new();
    for entity in doc.entities() {
        let EntityType::Unknown(unknown) = entity else {
            continue;
        };
        if unknown.dxf_name != "TCH_TEXT" {
            continue;
        }
        let Some(raw) = unknown.raw_dwg_data.as_deref() else {
            continue;
        };
        if raw.len() < 32 {
            continue;
        }
        *len_hist.entry(raw.len()).or_default() += 1;
        records.push((unknown.common.handle.value(), raw));
    }

    // A coordinate must be plausibly placed on a site plan: finite, below 1e7,
    // and at least one component large enough not to be a flag or factor.
    let plausible = |value: f64| value.is_finite() && value.abs() < 1.0e7 && value.abs() > 1.0e-3;
    let looks_like_xy = |x: f64, y: f64| {
        plausible(x)
            && plausible(y)
            && (x.abs() > 1.0e3 || y.abs() > 1.0e3)
            && x.abs() < 1.0e6
            && y.abs() < 1.0e6
    };

    let mut slots: BTreeMap<usize, Slot> = BTreeMap::new();
    let mut raw_slots: BTreeMap<usize, Slot> = BTreeMap::new();
    let mut min_len = usize::MAX;
    for (_, raw) in &records {
        min_len = min_len.min(raw.len());
    }
    if min_len == usize::MAX {
        min_len = 0;
    }
    for (handle, raw) in &records {
        let total = raw.len() * 8;
        for start in 0..total.saturating_sub(200) {
            let mut reader = Bits::new(raw, start);
            let x = reader.read_bit_double();
            let y = reader.read_bit_double();
            let z = reader.read_bit_double();
            if !looks_like_xy(x, y) || !plausible(z) {
                continue;
            }
            slots.entry(start).or_default().record(*handle, x, y, z);
        }
        // Tianzheng custom objects may store points as raw doubles instead of
        // BitDoubles; scan those separately.
        for start in 0..total.saturating_sub(200) {
            let mut reader = Bits::new(raw, start);
            let x = reader.read_raw_double();
            let y = reader.read_raw_double();
            let z = reader.read_raw_double();
            if !looks_like_xy(x, y) || !plausible(z) {
                continue;
            }
            raw_slots.entry(start).or_default().record(*handle, x, y, z);
        }
    }

    let mut ranked: Vec<(usize, &Slot)> = slots.iter().map(|(bit, slot)| (*bit, slot)).collect();
    ranked.sort_by(|a, b| b.1.hits.cmp(&a.1.hits));
    let mut raw_ranked: Vec<(usize, &Slot)> = raw_slots.iter().map(|(bit, slot)| (*bit, slot)).collect();
    raw_ranked.sort_by(|a, b| b.1.hits.cmp(&a.1.hits));

    // Where does the record's first/longest string start? Needed to measure the
    // private field block relative to the text stream.
    let mut text_bits: BTreeMap<usize, usize> = BTreeMap::new();
    for (_, raw) in &records {
        let mut best: Option<(usize, usize)> = None;
        let mut bit = 0usize;
        while bit + 32 < raw.len() * 8 {
            if let Some(text) = try_string(raw, bit) {
                let len = text.chars().count();
                if best.map(|(_, best_len)| len > best_len).unwrap_or(true) {
                    best = Some((bit, len));
                }
            }
            bit += 1;
        }
        if let Some((bit, _)) = best {
            *text_bits.entry(bit).or_default() += 1;
        }
    }
    let mut text_ranked: Vec<(usize, usize)> = text_bits.into_iter().collect();
    text_ranked.sort_by(|a, b| b.1.cmp(&a.1));

    let mut out = String::new();
    out.push_str(&format!("file: {path}\ntch_text records: {}\n", records.len()));
    out.push_str("\n--- raw length histogram (len: count) ---\n");
    for (len, count) in len_hist.iter() {
        out.push_str(&format!("{len:>5}: {count}\n"));
    }
    out.push_str("\n--- bit offsets yielding plausible (x, y, z) triples (top 25) ---\n");
    for (bit, slot) in ranked.iter().take(25) {
        out.push_str(&format!(
            "bit {bit:>5}  hits={:<5} x=[{:.1}, {:.1}] y=[{:.1}, {:.1}] z=[{:.1}, {:.1}]\n",
            slot.hits, slot.x_min, slot.x_max, slot.y_min, slot.y_max, slot.z_min, slot.z_max
        ));
        for sample in &slot.samples {
            out.push_str(&format!("         {sample}\n"));
        }
    }
    out.push_str("\n--- bit offsets of the longest decoded string (top 10) ---\n");
    for (bit, count) in text_ranked.iter().take(10) {
        out.push_str(&format!("bit {bit:>5}: {count} records\n"));
    }
    out.push_str("\n--- raw-double (RD) triple scan (top 15) ---\n");
    for (bit, slot) in raw_ranked.iter().take(15) {
        out.push_str(&format!(
            "bit {bit:>5}  hits={:<5} x=[{:.1}, {:.1}] y=[{:.1}, {:.1}] z=[{:.1}, {:.1}]\n",
            slot.hits, slot.x_min, slot.x_max, slot.y_min, slot.y_max, slot.z_min, slot.z_max
        ));
        for sample in &slot.samples {
            out.push_str(&format!("         {sample}\n"));
        }
    }
    fs::write(&out_path, out)?;
    println!("wrote {out_path}");
    Ok(())
}
