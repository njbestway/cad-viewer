//! Dump every `TCH_TEXT` record's content next to the candidate height slots,
//! so we can tell whether the slot at `x_bit + 134` is the drawn height or a
//! millimetre figure that still needs the drawing scale applied.

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

fn read_string_at(data: &[u8], bit: usize, max_chars: i16) -> Option<String> {
    if bit >= data.len() * 8 {
        return None;
    }
    let mut reader = Bits::new(data, bit);
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

fn find_anchor(data: &[u8], wanted: &str, limit_bits: usize) -> Option<usize> {
    let limit = limit_bits.min(data.len() * 8);
    (0..limit).find(|bit| read_string_at(data, *bit, 64).map_or(false, |text| text == wanted))
}

fn bd(raw: &[u8], bit: usize) -> (u32, f64) {
    Bits::new(raw, bit).read_bit_double()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: tch_text_heights <dwg> [out]");
    let out_path = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "tch-text-heights.txt".to_string());
    let doc: CadDocument = DwgReader::from_file(Path::new(&path))?.read()?;

    let mut rows: Vec<String> = Vec::new();
    for entity in doc.entities() {
        let EntityType::Unknown(unknown) = entity else {
            continue;
        };
        if unknown.dxf_name != "TCH_TEXT" {
            continue;
        }
        let raw = unknown.raw_dwg_data.as_deref().unwrap_or_default();
        let handle = unknown.common.handle.value();
        let Some(begin) = find_anchor(raw, "TDBXDATAMAP_BLOCK_BEGIN_", 1400) else {
            rows.push(format!("handle={handle} NO-ANCHOR len={}", raw.len()));
            continue;
        };
        let guid_bit = [1026isize, 756]
            .iter()
            .map(|d| begin as isize + d)
            .filter(|b| *b >= 0)
            .find(|b| {
                read_string_at(raw, *b as usize, 60)
                    .map_or(false, |t| t.len() == 38 && t.starts_with('{') && t.ends_with('}'))
            });
        let Some(guid_bit) = guid_bit else {
            rows.push(format!("handle={handle} NO-GUID begin={begin} len={}", raw.len()));
            continue;
        };
        let value = read_string_at(raw, guid_bit as usize + 618, 120).unwrap_or_default();

        let mut line = format!("handle={handle} layer={} len={} ", unknown.common.layer, raw.len());
        for k in 0..8isize {
            let x_bit = begin as isize - 154 - 64 * k;
            if x_bit < 0 {
                continue;
            }
            let (xf, x) = bd(raw, x_bit as usize);
            let (yf, y) = bd(raw, x_bit as usize + 66);
            let (zf, _z) = bd(raw, x_bit as usize + 132);
            let (hf, h) = bd(raw, x_bit as usize + 134);
            if xf == 0 && yf == 0 && x.abs() < 1.0e7 && y.abs() < 1.0e7 && (1.0e-3..=1.0e4).contains(&h) {
                let mut seq = String::new();
                let mut cursor = Bits::new(raw, x_bit as usize + 134);
                for index in 0..14 {
                    let (flag, value) = cursor.read_bit_double();
                    seq.push_str(&format!(" [{index}]f{flag}={value:.4}"));
                }
                line.push_str(&format!(
                    "k={k} x={x:.3} y={y:.3} zf={zf} hflag={hf} h={h:.4} | seq:"
                ));
                line.push_str(&seq);
                break;
            }
        }
        line.push_str(&format!(" value={value:?}"));
        rows.push(line);
    }
    rows.sort_by(|a, b| a.len().cmp(&b.len()));
    let mut out = format!("records: {}\n", rows.len());
    for row in &rows {
        out.push_str(row);
        out.push('\n');
    }
    fs::write(&out_path, out)?;
    println!("wrote {out_path} ({} records)", rows.len());
    Ok(())
}
