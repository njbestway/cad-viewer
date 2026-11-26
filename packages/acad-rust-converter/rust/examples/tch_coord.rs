//! Temporary native probe: does any TCH_TEXT raw record contain a double in the
//! drawing's coordinate range (roughly 5e4..3e5)?
//!
//! Scans every bit offset for both BitDouble and raw-double encodings and reports
//! offsets whose values vary across records — a fixed value is a drawing constant,
//! a varying one is the per-instance placement.

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
            b0 | (b1 << 8) | (b2 << 16) | (b3 << 24) | (b4 << 32) | (b5 << 40) | (b6 << 48)
                | (b7 << 56),
        )
    }
}

struct Slot {
    count: usize,
    min: f64,
    max: f64,
    samples: Vec<f64>,
}

impl Slot {
    fn record(&mut self, value: f64) {
        if self.count == 0 {
            self.min = value;
            self.max = value;
        } else {
            self.min = self.min.min(value);
            self.max = self.max.max(value);
        }
        self.count += 1;
        if self.samples.len() < 8 {
            self.samples.push(value);
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: tch_coord <dwg> [out]");
    let out_path = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "tch-coord.txt".to_string());
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
        if raw.len() < 64 {
            continue;
        }
        records.push((unknown.common.handle.value(), raw.to_vec()));
    }

    // Any finite, non-degenerate placement candidate. The drawing-space range
    // (5e4..3e5) misses TCH_TEXT records whose insertion point is stored in a
    // block-local or otherwise small scale, so this probe keeps every finite
    // magnitude up to a sane upper bound and drops the flag-expanded 0.0/1.0
    // sentinels that `read_bit_double` produces.
    let in_range = |value: f64| {
        value.is_finite()
            && value.abs() <= 1.0e7
            && value.abs() >= 1.0e-3
            && (value - 1.0).abs() > 1.0e-9
    };

    let mut bit_doubles: BTreeMap<usize, Slot> = BTreeMap::new();
    let mut raw_doubles: BTreeMap<usize, Slot> = BTreeMap::new();
    for (_, raw) in &records {
        let total = raw.len() * 8;
        for start in 0..total.saturating_sub(80) {
            let mut reader = Bits::new(raw, start);
            let (flag, value) = reader.read_bit_double();
            if flag == 0 && in_range(value) {
                bit_doubles
                    .entry(start)
                    .or_insert_with(|| Slot {
                        count: 0,
                        min: 0.0,
                        max: 0.0,
                        samples: Vec::new(),
                    })
                    .record(value);
            }
        }
        for start in 0..total.saturating_sub(80) {
            let mut reader = Bits::new(raw, start);
            let value = reader.read_raw_double();
            if in_range(value) {
                raw_doubles
                    .entry(start)
                    .or_insert_with(|| Slot {
                        count: 0,
                        min: 0.0,
                        max: 0.0,
                        samples: Vec::new(),
                    })
                    .record(value);
            }
        }
    }

    let mut ranked: Vec<(&str, usize, &Slot)> = Vec::new();
    for (bit, slot) in bit_doubles.iter() {
        ranked.push(("BD", *bit, slot));
    }
    for (bit, slot) in raw_doubles.iter() {
        ranked.push(("RD", *bit, slot));
    }
    // Prefer offsets that vary (spread > 1.0) and appear in many records.
    ranked.sort_by(|a, b| {
        let spread_a = (a.2.max - a.2.min).abs();
        let spread_b = (b.2.max - b.2.min).abs();
        let varying_a = spread_a > 1.0;
        let varying_b = spread_b > 1.0;
        varying_b
            .cmp(&varying_a)
            .then(b.2.count.cmp(&a.2.count))
            .then(spread_b.partial_cmp(&spread_a).unwrap_or(std::cmp::Ordering::Equal))
    });

    let mut out = String::new();
    out.push_str(&format!(
        "file: {path}\ntch_text records: {}\n",
        records.len()
    ));
    out.push_str("\n--- in-range doubles, varying offsets first (top 40) ---\n");
    for (kind, bit, slot) in ranked.iter().take(40) {
        out.push_str(&format!(
            "{kind} bit {bit:>5}  count={:<4} range=[{:.3}, {:.3}] spread={:.3}  samples={:?}\n",
            slot.count,
            slot.min,
            slot.max,
            (slot.max - slot.min).abs(),
            slot.samples
        ));
    }
    fs::write(&out_path, out)?;
    println!("wrote {out_path}");
    Ok(())
}
