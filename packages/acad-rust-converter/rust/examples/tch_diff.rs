//! Temporary native probe: locate the variable field block inside Tianzheng
//! `TCH_TEXT` records by diffing same-shaped instances bit by bit.
//!
//! Records with the same text and the same raw length differ only in the fields
//! that carry identity / placement (handles, insertion point, ...). Bits that
//! differ in almost every pair mark those variable fields, so the geometry block
//! can be isolated without knowing the private class layout.

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
    if !(1..=80).contains(&char_count) {
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

fn longest_text(raw: &[u8]) -> Option<(String, usize)> {
    let mut best: Option<(String, usize)> = None;
    let mut bit = 0usize;
    while bit + 32 < raw.len() * 8 {
        if let Some(text) = try_string(raw, bit) {
            if best
                .as_ref()
                .map(|(current, _)| text.len() > current.len())
                .unwrap_or(true)
            {
                best = Some((text, bit));
            }
        }
        bit += 1;
    }
    best
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: tch_diff <dwg> [out]");
    let out_path = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "tch-diff.txt".to_string());
    let doc: CadDocument = DwgReader::from_file(Path::new(&path))?.read()?;

    // (raw_len, text) -> list of (handle, raw, text_bit)
    let mut groups: BTreeMap<(usize, String), Vec<(u64, Vec<u8>, usize)>> = BTreeMap::new();
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
        let Some((text, text_bit)) = longest_text(raw) else {
            continue;
        };
        groups
            .entry((raw.len(), text))
            .or_default()
            .push((unknown.common.handle.value(), raw.to_vec(), text_bit));
    }

    let mut pairs = 0usize;
    let mut differing: Vec<usize> = Vec::new();
    let mut pair_samples: Vec<String> = Vec::new();
    for ((len, text), entries) in groups.iter() {
        if entries.len() < 2 {
            continue;
        }
        let (handle_a, raw_a, text_bit_a) = &entries[0];
        let (handle_b, raw_b, text_bit_b) = &entries[1];
        pairs += 1;
        let mut local: Vec<usize> = Vec::new();
        for bit in 0..len * 8 {
            let byte = bit >> 3;
            let mask = 0x80 >> (bit & 7);
            if (raw_a[byte] & mask) != (raw_b[byte] & mask) {
                local.push(bit);
            }
        }
        if pair_samples.len() < 12 {
            pair_samples.push(format!(
                "len={len} text={text:?} handles={handle_a}/{handle_b} text_bit={text_bit_a}/{text_bit_b} diff_bits={}",
                local.len()
            ));
        }
        differing.extend(local);
    }

    // Count how often each bit position differs across all same-shape pairs.
    let mut frequency: BTreeMap<usize, usize> = BTreeMap::new();
    for bit in differing {
        *frequency.entry(bit).or_default() += 1;
    }

    // Merge adjacent differing bits into ranges.
    let mut ranges: Vec<(usize, usize, usize)> = Vec::new(); // (start, end, max_hits)
    let mut current: Option<(usize, usize, usize)> = None;
    for (bit, hits) in frequency.iter() {
        match current {
            Some((start, end, max)) if *bit == end + 1 => {
                current = Some((start, *bit, max.max(*hits)));
            }
            Some((start, end, max)) => {
                ranges.push((start, end, max));
                current = Some((*bit, *bit, *hits));
            }
            None => current = Some((*bit, *bit, *hits)),
        }
    }
    if let Some(range) = current {
        ranges.push(range);
    }

    let mut out = String::new();
    out.push_str(&format!(
        "file: {path}\ntch_text groups: {}  same-shape pairs: {pairs}\n",
        groups.len()
    ));
    out.push_str("\n--- sample pairs ---\n");
    for sample in &pair_samples {
        out.push_str(sample);
        out.push('\n');
    }
    out.push_str("\n--- differing bit ranges (start..end, max occurrences) ---\n");
    for (start, end, max) in &ranges {
        out.push_str(&format!(
            "bit {start:>5}..{end:<5} len={:<5} max_hits={max}\n",
            end - start + 1
        ));
    }
    fs::write(&out_path, out)?;
    println!("wrote {out_path}");
    Ok(())
}
