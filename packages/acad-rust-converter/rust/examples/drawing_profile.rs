//! Profile a DWG's entity mix and block fan-out for viewer open-time analysis.
//!
//! Answers "why does this drawing take longer to render than a larger one":
//! parses the DWG once and reports, for model space and every block
//! definition, the entity-type mix, INSERT fan-out, and the fully expanded
//! entity count the scene converter must walk (a model-space INSERT of a
//! 500-entity block costs 500 convert steps, not one).
//!
//! Usage:
//!   cargo run --release --example drawing_profile -- <file.dwg>

use acadrust::{CadDocument, DwgReader, EntityType};
use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::io::Cursor;
use std::mem::discriminant;
use std::time::Instant;

/// Counts entities by enum variant without allocating a Debug string per
/// entity: the string is built once per variant, then only the discriminant
/// (an integer) is hashed.
#[derive(Default)]
struct TypeTable {
    index: HashMap<std::mem::Discriminant<EntityType>, usize>,
    names: Vec<String>,
    counts: Vec<usize>,
}

impl TypeTable {
    fn add(&mut self, entity: &EntityType) {
        let key = discriminant(entity);
        let idx = match self.index.entry(key) {
            Entry::Occupied(entry) => *entry.get(),
            Entry::Vacant(entry) => {
                let debug = format!("{:?}", entity);
                let name = debug
                    .split(['(', '{', ' '])
                    .next()
                    .unwrap_or("?")
                    .to_string();
                let idx = self.names.len();
                self.names.push(name);
                self.counts.push(0);
                entry.insert(idx);
                idx
            }
        };
        self.counts[idx] += 1;
    }

    fn sorted(&self) -> Vec<(&str, usize)> {
        let mut rows: Vec<_> = self
            .names
            .iter()
            .zip(self.counts.iter())
            .map(|(name, count)| (name.as_str(), *count))
            .collect();
        rows.sort_by(|a, b| b.1.cmp(&a.1));
        rows
    }
}

struct BlockInfo {
    direct_entities: usize,
    text_entities: usize,
    inserts: Vec<String>,
}

#[derive(Clone, Copy, Default)]
struct Expansion {
    entities: usize,
    text: usize,
    depth: usize,
}

/// Fully expands a block definition, memoised per block name. Recursion is
/// guarded against cyclic definitions (which malformed DWGs can contain).
fn expand_block(
    name: &str,
    blocks: &HashMap<String, BlockInfo>,
    memo: &mut HashMap<String, Expansion>,
    stack: &mut Vec<String>,
) -> Expansion {
    if let Some(done) = memo.get(name) {
        return *done;
    }
    if stack.iter().any(|entry| entry == name) {
        return Expansion::default();
    }
    let Some(block) = blocks.get(name) else {
        return Expansion::default();
    };
    stack.push(name.to_string());
    let mut total = Expansion {
        entities: block.direct_entities,
        text: block.text_entities,
        depth: 0,
    };
    for child in &block.inserts {
        let inner = expand_block(child, blocks, memo, stack);
        total.entities += inner.entities;
        total.text += inner.text;
        total.depth = total.depth.max(inner.depth + 1);
    }
    stack.pop();
    memo.insert(name.to_string(), total);
    total
}

fn is_text(entity: &EntityType) -> bool {
    matches!(
        entity,
        EntityType::Text(_)
            | EntityType::MText(_)
            | EntityType::AttributeEntity(_)
            | EntityType::AttributeDefinition(_)
            | EntityType::Leader(_)
            | EntityType::MultiLeader(_)
    )
}

/// Counts how often each TEXT/MTEXT rendering key appears in the expanded
/// model space. A high repeat rate means glyph meshes could be shared instead
/// of triangulated once per instance.
fn collect_text_keys<'a>(
    doc: &'a CadDocument,
    entities: impl Iterator<Item = &'a EntityType>,
    keys: &mut HashMap<String, usize>,
    stack: &mut Vec<String>,
) {
    for entity in entities {
        match entity {
            EntityType::Text(text) => {
                let key = format!(
                    "T\0{}\0{:.4}\0{:.4}\0{:.4}",
                    text.value, text.height, text.rotation, text.width_factor
                );
                *keys.entry(key).or_default() += 1;
            }
            EntityType::MText(mtext) => {
                let key = format!(
                    "M\0{}\0{:.4}\0{:.4}\0{:.4}",
                    mtext.value, mtext.height, mtext.rotation, mtext.rectangle_width
                );
                *keys.entry(key).or_default() += 1;
            }
            EntityType::Insert(insert) => {
                let name = &insert.block_name;
                if name.is_empty() || stack.iter().any(|entry| entry == name) {
                    continue;
                }
                stack.push(name.clone());
                collect_text_keys(doc, doc.entities_in_block(name), keys, stack);
                stack.pop();
            }
            _ => {}
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .expect("usage: drawing_profile <file.dwg>");
    let raw = std::fs::read(&path)?;
    let source_mb = raw.len() as f64 / 1048576.0;
    let t0 = Instant::now();
    let doc = DwgReader::from_stream(Cursor::new(&raw)).read()?;
    println!(
        "{path}\n  source {source_mb:.2} MB, wasm-time parse {:.0} ms",
        t0.elapsed().as_secs_f64() * 1000.0
    );

    let mut all_types = TypeTable::default();
    let mut model_types = TypeTable::default();
    let mut insert_refs: HashMap<String, usize> = HashMap::new();
    let mut model_insert_refs: HashMap<String, usize> = HashMap::new();

    for entity in doc.entities() {
        all_types.add(entity);
        if let EntityType::Insert(insert) = entity {
            *insert_refs.entry(insert.block_name.clone()).or_default() += 1;
        }
    }
    for entity in doc.model_space_entities() {
        model_types.add(entity);
        if let EntityType::Insert(insert) = entity {
            *model_insert_refs
                .entry(insert.block_name.clone())
                .or_default() += 1;
        }
    }

    let mut blocks: HashMap<String, BlockInfo> = HashMap::new();
    for record in doc.block_records.iter() {
        let mut info = BlockInfo {
            direct_entities: record.entity_handles.len(),
            text_entities: 0,
            inserts: Vec::new(),
        };
        for handle in &record.entity_handles {
            if let Some(entity) = doc.get_entity(*handle) {
                if is_text(entity) {
                    info.text_entities += 1;
                }
                if let EntityType::Insert(insert) = entity {
                    info.inserts.push(insert.block_name.clone());
                }
            }
        }
        blocks.insert(record.name.clone(), info);
    }

    let mut memo = HashMap::new();
    let mut stack = Vec::new();
    let model = expand_block("*Model_Space", &blocks, &mut memo, &mut stack);
    let paper: Vec<(String, Expansion)> = blocks
        .keys()
        .filter(|name| name.starts_with("*Paper_Space"))
        .map(|name| {
            (
                name.clone(),
                expand_block(name, &blocks, &mut memo, &mut stack),
            )
        })
        .collect();

    println!(
        "  all entities {}, model-space direct {}, block definitions {}",
        doc.entities().count(),
        doc.model_space_entities().count(),
        doc.block_records.iter().count()
    );
    println!(
        "  model space expanded: {} entities (+{:.1}x), {} text, depth {}",
        model.entities,
        model.entities as f64 / doc.model_space_entities().count().max(1) as f64,
        model.text,
        model.depth
    );
    if !paper.is_empty() {
        let paper_entities: usize = paper.iter().map(|(_, e)| e.entities).sum();
        let paper_direct: usize = paper
            .iter()
            .map(|(name, _)| blocks.get(name).map_or(0, |b| b.direct_entities))
            .sum();
        println!(
            "  paper layouts: {} blocks, direct {} entities, expanded {}",
            paper.len(),
            paper_direct,
            paper_entities
        );
    }

    println!("\n--- model-space entity types (direct) ---");
    for (name, count) in model_types.sorted().into_iter().take(20) {
        println!("  {name:<22} {count}");
    }

    println!("\n--- all entity types (incl. block definitions) ---");
    for (name, count) in all_types.sorted().into_iter().take(25) {
        println!("  {name:<22} {count}");
    }

    println!("\n--- block definitions by direct entity count ---");
    let mut by_size: Vec<_> = blocks
        .iter()
        .map(|(name, info)| (name, info.direct_entities, info.text_entities))
        .collect();
    by_size.sort_by(|a, b| b.1.cmp(&a.1));
    for (name, entities, text) in by_size.iter().take(20) {
        let refs = insert_refs.get(*name).copied().unwrap_or(0);
        println!("  {name:<32} {entities:>6} entities ({text} text), {refs} refs");
    }

    println!("\n--- model-space INSERTs by expanded cost ---");
    let mut by_cost: Vec<_> = model_insert_refs
        .iter()
        .map(|(name, refs)| {
            let inner = expand_block(name, &blocks, &mut memo, &mut stack);
            (name, *refs, inner)
        })
        .collect();
    by_cost.sort_by(|a, b| (b.1 * b.2.entities).cmp(&(a.1 * a.2.entities)));
    for (name, refs, inner) in by_cost.iter().take(20) {
        println!(
            "  {name:<32} {refs:>5} refs x {:>6} = {:>8} entities ({:>6} text, depth {})",
            inner.entities,
            refs * inner.entities,
            refs * inner.text,
            inner.depth
        );
    }
    let all_insert_cost: usize = by_cost.iter().map(|(_, r, e)| r * e.entities).sum();
    println!(
        "  model INSERT total expanded: {all_insert_cost} entities across {} definitions",
        by_cost.len()
    );

    println!("\n--- INSERTs never referenced by model space ---");
    let mut unused: Vec<_> = insert_refs
        .iter()
        .filter(|(name, _)| !model_insert_refs.contains_key(*name))
        .map(|(name, refs)| {
            let inner = expand_block(name, &blocks, &mut memo, &mut stack);
            (name, *refs, inner.entities)
        })
        .collect();
    unused.sort_by(|a, b| (b.1 * b.2).cmp(&(a.1 * a.2)));
    for (name, refs, entities) in unused.iter().take(10) {
        println!("  {name:<32} {refs} refs x {entities} entities");
    }

    let mut text_keys: HashMap<String, usize> = HashMap::new();
    let mut text_stack: Vec<String> = Vec::new();
    collect_text_keys(
        &doc,
        doc.model_space_entities(),
        &mut text_keys,
        &mut text_stack,
    );
    let total_texts: usize = text_keys.values().sum();
    let unique_texts = text_keys.len();
    let mut top_texts: Vec<_> = text_keys.iter().collect();
    top_texts.sort_by(|a, b| b.1.cmp(a.1));
    println!("\n--- model-space text sharing (text+height+rotation+width) ---");
    println!(
        "  texts {total_texts} total, {unique_texts} unique ({:.1}% repeatable), top 10 cover {}",
        total_texts.saturating_sub(unique_texts) as f64 * 100.0 / total_texts.max(1) as f64,
        top_texts.iter().take(10).map(|(_, count)| **count).sum::<usize>()
    );
    for (key, count) in top_texts.iter().take(10) {
        let display = key.replace('\0', " | ");
        let display: String = display.chars().take(64).collect();
        println!("  {count:>6} x {display}");
    }

    println!("\n--- per-INSERT text sharing (top 3 model-space blocks) ---");
    for (name, refs, _) in by_cost.iter().take(3) {
        let mut keys: HashMap<String, usize> = HashMap::new();
        let mut block_stack = vec![(*name).clone()];
        collect_text_keys(
            &doc,
            doc.entities_in_block(name),
            &mut keys,
            &mut block_stack,
        );
        let total: usize = keys.values().sum();
        let unique = keys.len();
        if total == 0 {
            println!("  {name:<32} 0 texts");
            continue;
        }
        println!(
            "  {name:<32} {total:>6} texts, {unique:>6} unique ({:.1}% repeatable), {refs} refs",
            total.saturating_sub(unique) as f64 * 100.0 / total as f64
        );
    }

    Ok(())
}
