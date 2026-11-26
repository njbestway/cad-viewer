//! Locate the real text height of a TCH_TEXT record.
//!
//! `tch_text_probe` only scanned the first 600 bits and assumed the BitDouble
//! at `x_bit + 134` is the height. CADSee reports 265.8228 for handle 13946
//! while that slot reads 3.5, so this probe dumps the whole merged-stream
//! record instead: every bit offset that decodes as a full IEEE-754 BitDouble,
//! plus a value-triggered search around the CADSee figure.

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

fn try_string(data: &[u8], bit: usize) -> Option<String> {
    let mut reader = Bits::new(data, bit);
    let char_count = reader.read_bit_short();
    if !(1..=120).contains(&char_count) {
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

fn read_bd(raw: &[u8], bit: usize) -> (u32, f64) {
    Bits::new(raw, bit).read_bit_double()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: tch_height <dwg> <handle> [out]");
    let wanted = std::env::args()
        .nth(2)
        .and_then(|s| s.parse::<u64>().ok())
        .expect("handle");
    let out_path = std::env::args()
        .nth(3)
        .unwrap_or_else(|| "tch-height.txt".to_string());
    let doc: CadDocument = DwgReader::from_file(Path::new(&path))?.read()?;

    let mut out = String::new();
    let mut raw_len = 0usize;
    for entity in doc.entities() {
        let EntityType::Unknown(unknown) = entity else {
            continue;
        };
        if unknown.dxf_name != "TCH_TEXT" || unknown.common.handle.value() != wanted {
            continue;
        }
        let raw = unknown.raw_dwg_data.as_deref().unwrap_or_default();
        raw_len = raw.len();
        out.push_str(&format!("handle={} raw_bytes={}\n", wanted, raw.len()));
        for bit in 0..1400usize {
            if let Some(text) = try_string(raw, bit) {
                if text.len() > 1 {
                    out.push_str(&format!("  str bit {bit}: {text:?}\n"));
                }
            }
        }
        for bit in 0..raw.len() * 8 {
            let (flag, value) = read_bd(raw, bit);
            if flag != 0 || !value.is_finite() {
                continue;
            }
            let magnitude = value.abs();
            if !(0.05..=1.0e7).contains(&magnitude) {
                continue;
            }
            let near = (value - 265.8228).abs() < 0.5;
            out.push_str(&format!(
                "  bd bit {bit:>5}: {value:.6}{}\n",
                if near { "   <<< NEAR CADSee 265.8228" } else { "" }
            ));
        }
    }
    if raw_len == 0 {
        out.push_str(&format!("handle {wanted} not found as TCH_TEXT\n"));
    }
    fs::write(&out_path, &out)?;
    println!("wrote {out_path} ({raw_len} raw bytes)");
    Ok(())
}
