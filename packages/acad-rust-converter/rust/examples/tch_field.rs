//! Temporary native probe: decode the candidate geometry field block found by
//! `tch_diff` (differing bits around 348..475) as both BitDouble and raw double,
//! for a handful of TCH_TEXT records.
//!
//! If one offset yields drawing-scale values that vary per record, that offset is
//! the insertion point (or one of its components).

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
    fn read_raw_double(&mut self) -> f64 {
        let b0 = self.read_byte() as u64;
        let b1 = self.read_byte() as u64;
        let b2 = self.read_byte() as u64;
        let b3 = self.read_byte() as u64;
        let b4 = self.read_byte() as u64;
        let b5 = self.read_byte() as u64;
        let b6 = self.read_byte() as u64;
        let b7 = self.read_byte() as u64;
        f64::from_bits(
            b0 | (b1 << 8) | (b2 << 16) | (b3 << 24) | (b4 << 32) | (b5 << 40) | (b6 << 48) | (b7 << 56),
        )
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: tch_field <dwg> [out]");
    let out_path = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "tch-field.txt".to_string());
    let doc: CadDocument = DwgReader::from_file(Path::new(&path))?.read()?;

    let mut records: Vec<(u64, Vec<u8>)> = Vec::new();
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
        records.push((unknown.common.handle.value(), raw.to_vec()));
        if records.len() >= 12 {
            break;
        }
    }

    let mut out = String::new();
    for (handle, raw) in &records {
        out.push_str(&format!("handle={handle} len={}\n", raw.len()));
        out.push_str("  BD at: ");
        for start in [349usize, 351, 353, 415, 417, 419, 481, 483, 485, 484, 486, 488, 490] {
            let mut reader = Bits::new(raw, start);
            let (flag, value) = reader.read_bit_double();
            out.push_str(&format!("[{start}:f{flag}={value:.4}] "));
        }
        out.push('\n');
        out.push_str("  RD at: ");
        for start in [351usize, 353, 417, 419, 483, 485] {
            let mut reader = Bits::new(raw, start);
            let value = reader.read_raw_double();
            out.push_str(&format!("[{start}={value:.4}] "));
        }
        out.push('\n');
    }
    fs::write(&out_path, out)?;
    println!("wrote {out_path}");
    Ok(())
}
