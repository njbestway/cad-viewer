//! Temporary native probe: brute-force `BS char_count + UTF-16LE` text decoding
//! at every bit offset of every Tianzheng (TCH_*) unknown-entity raw record.
//!
//! R2007+ DWG keeps variable text in a separate string stream that is read with
//! a bit-shifted byte reader (acadrust `read_variable_text`), so a byte-aligned
//! scan cannot find it. This settles whether a missing label actually lives
//! inside an undecoded custom object.

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
    fn read_raw_short(&mut self) -> i16 {
        let low = self.read_byte() as u16;
        let high = self.read_byte() as u16;
        (low | (high << 8)) as i16
    }
    fn read_bit_short(&mut self) -> i16 {
        match self.read_bits(2) {
            0 => self.read_raw_short(),
            1 => self.read_byte() as i16,
            2 => 0,
            _ => 256,
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

/// Tries to decode one `BS + UTF-16LE` string starting at `bit`.
/// Returns the decoded string when every character is plausible text.
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
    let mut chars = Vec::with_capacity(count);
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: tch_probe <dwg> [out]");
    let out_path = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "tch-strings.txt".to_string());
    let doc: CadDocument = DwgReader::from_file(Path::new(&path))?.read()?;

    let token = "L+S+F+Z+XD";
    let mut found: BTreeMap<String, usize> = BTreeMap::new();
    let mut hits: Vec<String> = Vec::new();
    let mut decoded_records = 0usize;
    let mut probed = 0usize;

    for entity in doc.entities() {
        let EntityType::Unknown(unknown) = entity else {
            continue;
        };
        let Some(raw) = unknown.raw_dwg_data.as_deref() else {
            continue;
        };
        if raw.len() < 8 {
            continue;
        }
        probed += 1;
        let mut record_strings: Vec<String> = Vec::new();
        let mut bit = 0usize;
        while bit + 32 < raw.len() * 8 {
            if let Some(text) = try_string(raw, bit) {
                if text.contains(token) {
                    hits.push(format!(
                        "{} handle={:?} layer={} bit={} -> {}",
                        unknown.dxf_name,
                        unknown.common.handle,
                        unknown.common.layer,
                        bit,
                        text
                    ));
                }
                record_strings.push(text);
            }
            bit += 1;
        }
        for text in record_strings {
            *found.entry(text).or_default() += 1;
        }
        decoded_records += 1;
    }

    let mut sorted: Vec<_> = found.into_iter().collect();
    sorted.sort_by(|a, b| b.1.cmp(&a.1));
    let mut out = String::new();
    out.push_str(&format!("file: {path}\nprobed records: {probed} ({decoded_records} decoded)\n"));
    out.push_str(&format!("\n--- token hits ({token}) ---\n"));
    if hits.is_empty() {
        out.push_str("(none)\n");
    }
    for hit in hits.iter().take(40) {
        out.push_str(hit);
        out.push('\n');
    }
    out.push_str("\n--- most frequent decoded strings ---\n");
    for (text, count) in sorted.iter().take(120) {
        out.push_str(&format!("{count:>6}  {text}\n"));
    }
    fs::write(&out_path, out)?;
    println!("wrote {out_path}");
    Ok(())
}
