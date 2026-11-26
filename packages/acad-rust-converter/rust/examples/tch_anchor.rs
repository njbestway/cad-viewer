//! Temporary native probe: can `TDBXDATAMAP_BLOCK_BEGIN_` anchor the geometry?
//!
//! Host drawing:  BEGIN @569 -> x @351 (569-218), y @417 (+66), text @2213.
//! Base drawing:  BEGIN @469 -> x @251 (469-218), text @1843; and a variant with
//!                BEGIN @405 -> x @251 (405-154), text @1779.
//!
//! So the record head before the data-map block is either 218 or 154 bits long.
//! This probe checks, per record, which of the two candidates yields a real
//! BitDouble (flag 00) for x *and* y, and whether `GUID + 618` lands on a text.

use acadrust::{CadDocument, DwgReader, EntityType};
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

fn is_text_char(value: u16) -> bool {
    value == 0x09
        || value == 0x0a
        || (0x20..0x7f).contains(&value)
        || (0x2000..0x2070).contains(&value)
        || (0x3000..0x3040).contains(&value)
        || (0x4e00..0xa000).contains(&value)
        || (0xff00..0xff70).contains(&value)
}

fn read_string_at(data: &[u8], bit: usize, max: i16) -> Option<String> {
    let mut reader = Bits::new(data, bit);
    let char_count = reader.read_bit_short();
    if !(1..=max).contains(&char_count) {
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

fn find_string(raw: &[u8], wanted: &str, limit: usize) -> Option<usize> {
    (0..limit.min(raw.len() * 8)).find(|bit| read_string_at(raw, *bit, 64).as_deref() == Some(wanted))
}

fn find_guid(raw: &[u8]) -> Option<usize> {
    for bit in 0..raw.len() * 8 {
        if let Some(text) = read_string_at(raw, bit, 60) {
            if text.len() == 38 && text.starts_with('{') && text.ends_with('}') {
                return Some(bit);
            }
        }
    }
    None
}

fn read_bd(raw: &[u8], bit: usize) -> (u32, f64) {
    Bits::new(raw, bit).read_bit_double()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: tch_anchor <dwg> [out]");
    let out_path = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "tch-anchor.txt".to_string());
    let doc: CadDocument = DwgReader::from_file(Path::new(&path))?.read()?;

    let mut out = String::new();
    let mut total = 0usize;
    let mut hit_long = 0usize;
    let mut hit_short = 0usize;
    let mut head_hist = [0usize; 8];
    let mut missed: Vec<String> = Vec::new();
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
        if raw.len() < 96 {
            continue;
        }
        total += 1;
        let handle = unknown.common.handle.value();
        let Some(begin) = find_string(raw, "TDBXDATAMAP_BLOCK_BEGIN_", 1400) else {
            if missed.len() < 20 {
                missed.push(format!("handle={handle} len={} no BEGIN", raw.len()));
            }
            continue;
        };
        let guid = find_guid(raw);
        let text_bit = guid.map(|g| g + 618);
        let text = text_bit.and_then(|b| read_string_at(raw, b, 120));

        // Head lengths observed so far: 154 / 218 / 282 bits, i.e. 154 + 64*k.
        // Pick the first candidate whose x and y are both *explicit* doubles
        // (flag 00, not the 0.0/1.0 shorthand) with a sane magnitude and a
        // plausible text height at +134. Without the height check, records whose
        // head carries an extra 64-bit group read as an all-zero block at k-1.
        let mut chosen: Option<(usize, isize, u32, u32, f64, f64, f64)> = None;
        for k in 0..8usize {
            let x_bit = begin as isize - 154 - 64 * k as isize;
            if x_bit < 0 {
                continue;
            }
            let (fx, x) = read_bd(raw, x_bit as usize);
            let (fy, y) = read_bd(raw, x_bit as usize + 66);
            let (_, h) = read_bd(raw, x_bit as usize + 134);
            if fx == 0
                && fy == 0
                && x.abs() < 1.0e7
                && y.abs() < 1.0e7
                && h.is_finite()
                && (1.0e-3..1.0e4).contains(&h)
            {
                chosen = Some((k, x_bit, fx, fy, x, y, h));
                break;
            }
        }
        let Some((k, x_bit, fx, fy, x, y, h)) = chosen else {
            if missed.len() < 20 {
                missed.push(format!(
                    "handle={handle} len={} begin={begin} no head candidate, text={:?}",
                    raw.len(),
                    text
                ));
            }
            continue;
        };
        head_hist[k] += 1;
        if begin as isize - x_bit == 218 {
            hit_long += 1;
        }
        if begin as isize - x_bit == 154 {
            hit_short += 1;
        }
        if total <= 40 || k != 1 {
            out.push_str(&format!(
                "handle={handle} len={} begin={begin} k={k} guid={:?} text={:?}\n    x(f{fx})={x:.3} y(f{fy})={y:.3} z={:.3} h={h:.3}\n",
                raw.len(),
                guid,
                text,
                read_bd(raw, x_bit as usize + 132).1
            ));
        }
    }

    out.push_str(&format!(
        "\ntotal={total} hit_long={hit_long} hit_short={hit_short} heads={head_hist:?} missed={}\n",
        missed.len()
    ));
    for line in &missed {
        out.push_str(line);
        out.push('\n');
    }
    fs::write(&out_path, out)?;
    println!("wrote {out_path}");
    Ok(())
}
