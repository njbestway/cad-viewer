//! Temporary native probe: dump the candidate TCH_TEXT layout
//! (x @ 351, y @ 417, z @ 483, height @ 485) plus every decodable string in the
//! record, so the real display text can be told apart from the data-map GUID.

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
    if !has_cjk && count < 2 {
        return None;
    }
    Some(String::from_utf16_lossy(&chars))
}

fn read_bd(raw: &[u8], bit: usize) -> (u32, f64) {
    Bits::new(raw, bit).read_bit_double()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: tch_text_probe <dwg> [out]");
    let out_path = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "tch-text-layout.txt".to_string());
    let only_handle = std::env::args().nth(3).and_then(|s| s.parse::<u64>().ok());
    let doc: CadDocument = DwgReader::from_file(Path::new(&path))?.read()?;

    let mut out = String::new();
    let mut count = 0usize;
    let mut flags_x = [0usize; 4];
    let mut flags_y = [0usize; 4];
    let mut odd: Vec<String> = Vec::new();
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
        if let Some(handle) = only_handle {
            if unknown.common.handle.value() != handle {
                continue;
            }
        }
        let (probe_x, probe_y) = (read_bd(raw, 351), read_bd(raw, 417));
        flags_x[(probe_x.0 as usize).min(3)] += 1;
        flags_y[(probe_y.0 as usize).min(3)] += 1;
        if (probe_x.0 != 0 || probe_y.0 != 0) && odd.len() < 12 {
            odd.push(format!(
                "handle={} len={} x(f{})={:.3} y(f{})={:.3}",
                unknown.common.handle.value(),
                raw.len(),
                probe_x.0,
                probe_x.1,
                probe_y.0,
                probe_y.1
            ));
        }
        count += 1;
        if count > 30 && only_handle.is_none() {
            continue;
        }
        if only_handle.is_some() {
            for bit in 0..600usize {
                let (flag, value) = read_bd(raw, bit);
                if flag == 0 && value.is_finite() {
                    out.push_str(&format!("    BD bit {bit:>4}: {value:.6}\n"));
                }
            }
        }
        let (fx, x) = read_bd(raw, 351);
        let (fy, y) = read_bd(raw, 417);
        let (fz, z) = read_bd(raw, 483);
        let (fh, height) = read_bd(raw, 485);
        let (_, after_height) = read_bd(raw, 551);
        let (_, next_2) = read_bd(raw, 617);
        out.push_str(&format!(
            "handle={} layer={} len={} x(f{fx})={x:.3} y(f{fy})={y:.3} z(f{fz})={z:.3} h(f{fh})={height:.3} b551={after_height:.3} b617={next_2:.3}\n",
            unknown.common.handle.value(),
            unknown.common.layer,
            raw.len()
        ));
        let mut strings: Vec<(usize, String)> = Vec::new();
        for bit in 0..raw.len() * 8 {
            if let Some(text) = try_string(raw, bit) {
                if !strings.iter().any(|(_, existing)| *existing == text) {
                    strings.push((bit, text));
                }
            }
        }
        for (bit, text) in strings {
            out.push_str(&format!("    bit {bit:>5}: {text}\n"));
        }
    }
    out.push_str(&format!(
        "\n--- x@351 flags {:?}  y@417 flags {:?} ---\n",
        flags_x, flags_y
    ));
    for line in &odd {
        out.push_str(line);
        out.push('\n');
    }
    fs::write(&out_path, out)?;
    println!("wrote {out_path}");
    Ok(())
}
