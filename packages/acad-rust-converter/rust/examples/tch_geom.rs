//! Temporary native probe: dump one unknown entity's raw DWG record and hunt for
//! consecutive IEEE-754 bit doubles (2-bit flag + 64 bits, 66-bit stride), to
//! judge whether Tianzheng text geometry (insertion point / height) can be
//! decoded from `raw_dwg_data`.

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
    fn read_bits(&mut self, count: usize) -> u64 {
        let mut value = 0u64;
        for _ in 0..count {
            value = (value << 1) | self.read_bit() as u64;
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
    /// Bit-double, matching acadrust: 00 = full IEEE double, 01 = 1.0,
    /// 10 = 0.0, 11 = 0.0.
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
}

fn hex(bytes: &[u8], max: usize) -> String {
    let slice = &bytes[..bytes.len().min(max)];
    let mut out = String::new();
    for (index, chunk) in slice.chunks(16).enumerate() {
        out.push_str(&format!("{:04x}  ", index * 16));
        for byte in chunk {
            out.push_str(&format!("{byte:02x} "));
        }
        for _ in chunk.len()..16 {
            out.push_str("   ");
        }
        out.push_str(" |");
        for byte in chunk {
            out.push(if (0x20..=0x7e).contains(byte) {
                *byte as char
            } else {
                '.'
            });
        }
        out.push_str("|\n");
    }
    out
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: tch_geom <dwg> <handle> [out]");
    // Handle's Debug prints the raw u64 in decimal; accept `0x`-prefixed hex too.
    let arg = std::env::args().nth(2).unwrap_or_default();
    let target = match arg.strip_prefix("0x").or_else(|| arg.strip_prefix("0X")) {
        Some(hex) => u64::from_str_radix(hex, 16),
        None => arg.parse::<u64>(),
    }
    .expect("handle must be decimal or 0x-prefixed hex");
    let out_path = std::env::args()
        .nth(3)
        .unwrap_or_else(|| "tch-geom.txt".to_string());
    let doc: CadDocument = DwgReader::from_file(Path::new(&path))?.read()?;

    let mut out = String::new();
    for entity in doc.entities() {
        let EntityType::Unknown(unknown) = entity else {
            continue;
        };
        if unknown.common.handle.value() != target {
            continue;
        }
        let raw = unknown.raw_dwg_data.as_deref().unwrap_or_default();
        out.push_str(&format!(
            "class={} handle={:?} layer={} raw_len={} bits={}\n\n",
            unknown.dxf_name,
            unknown.common.handle,
            unknown.common.layer,
            raw.len(),
            raw.len() * 8
        ));
        out.push_str(&hex(raw, 384));
        out.push_str("\n--- consecutive full bit-double triples (all flags 00) ---\n");
        let total = raw.len() * 8;
        for start in 0..total.saturating_sub(200) {
            let mut reader = Bits::new(raw, start);
            if reader.read_bits(2) != 0 || reader.read_bits(2) != 0 || reader.read_bits(2) != 0 {
                continue;
            }
            let mut reader = Bits::new(raw, start);
            let a = reader.read_bit_double();
            let b = reader.read_bit_double();
            let c = reader.read_bit_double();
            let plausible = |value: f64| {
                value.is_finite() && value.abs() < 1.0e7 && (value == 0.0 || value.abs() > 1.0e-4)
            };
            if plausible(a) && plausible(b) && plausible(c) {
                out.push_str(&format!(
                    "bit {start:>6}  x={a:<18.6} y={b:<18.6} z={c:<12.6}\n"
                ));
            }
        }
        break;
    }
    fs::write(&out_path, out)?;
    println!("wrote {out_path}");
    Ok(())
}
