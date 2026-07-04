//! Label sanitization + launch-id generation.
//!
//! Mirrors `launcherd.ts`'s `sanitizeLabel` / `generateLaunchId`. The sanitized
//! label is used two ways from ONE cleaned value (so they can't diverge): as
//! the podman container name prefix, and as the human-facing RC session title
//! shown in the Claude app's session list.

use std::time::{SystemTime, UNIX_EPOCH};

/// Lowercase; collapse any run of chars outside `[a-z0-9_.-]` to a single `-`;
/// strip leading/trailing `-._`; cap at 40 chars. Empty result → `None` (an
/// all-punctuation or empty label falls back to the plain `box-<rand>` id).
///
/// Equivalent to the TS `.replace(/[^a-z0-9_.-]+/g,"-").replace(/^[-._]+|[-._]+$/g,"").slice(0,40)`.
pub fn sanitize_label(label: Option<&str>) -> Option<String> {
    let raw = label?;
    let mut out = String::with_capacity(raw.len());
    let mut prev_dash = false;
    for ch in raw.chars() {
        let c = ch.to_ascii_lowercase();
        let keep = c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.' | '-');
        if keep {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            // Collapse a run of disallowed chars to a single '-'.
            out.push('-');
            prev_dash = true;
        }
    }
    // Strip leading/trailing '-', '.', '_'.
    let trimmed = out.trim_matches(|c| matches!(c, '-' | '.' | '_'));
    // Cap at 40 chars (char-count, matching JS String.slice on BMP input).
    let capped: String = trimmed.chars().take(40).collect();
    if capped.is_empty() {
        None
    } else {
        Some(capped)
    }
}

/// A short random suffix, `<base36(time)>-<6 base36 chars>`, matching the TS
/// shape. Randomness is drawn from `/dev/urandom`; the time component keeps IDs
/// loosely sortable and adds entropy. The suffix is ALWAYS appended so two
/// concurrent same-label requests never collide on podman's name-uniqueness.
fn rand_suffix() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut rand_bytes = [0u8; 8];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut rand_bytes);
    }
    let rand = u64::from_le_bytes(rand_bytes);
    format!("{}-{}", base36(now), &base36(rand)[..6.min(base36(rand).len())])
}

/// Lowercase base36 of a u64 (digits 0-9a-z), like JS `Number.toString(36)`.
fn base36(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut buf = Vec::new();
    while n > 0 {
        buf.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    buf.reverse();
    // Pad to at least 6 so the [..6] slice in rand_suffix always has material.
    while buf.len() < 6 {
        buf.push(b'0');
    }
    String::from_utf8(buf).expect("base36 is ascii")
}

/// `box-<label>-<rand>` when a (sanitized) label is present, else `box-<rand>`.
pub fn generate_launch_id(label: Option<&str>) -> String {
    match label {
        Some(l) => format!("box-{l}-{}", rand_suffix()),
        None => format!("box-{}", rand_suffix()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_lowercases_and_dashes_junk() {
        assert_eq!(sanitize_label(Some("Fix Auth Bug!")).as_deref(), Some("fix-auth-bug"));
        assert_eq!(sanitize_label(Some("HooksMith")).as_deref(), Some("hooksmith"));
    }

    #[test]
    fn sanitize_strips_edges_and_collapses_runs() {
        assert_eq!(sanitize_label(Some("--a  b__")).as_deref(), Some("a-b"));
        assert_eq!(sanitize_label(Some("...weird///name...")).as_deref(), Some("weird-name"));
    }

    #[test]
    fn sanitize_keeps_allowed_punctuation() {
        assert_eq!(sanitize_label(Some("v1.2_beta-3")).as_deref(), Some("v1.2_beta-3"));
    }

    #[test]
    fn sanitize_empty_or_all_junk_is_none() {
        assert_eq!(sanitize_label(Some("")), None);
        assert_eq!(sanitize_label(Some("!!!")), None);
        assert_eq!(sanitize_label(Some("---")), None);
        assert_eq!(sanitize_label(None), None);
    }

    #[test]
    fn sanitize_caps_at_40() {
        let long = "a".repeat(100);
        assert_eq!(sanitize_label(Some(&long)).unwrap().len(), 40);
    }

    #[test]
    fn launch_id_shapes() {
        let with = generate_launch_id(Some("hooksmith"));
        assert!(with.starts_with("box-hooksmith-"), "got {with}");
        let without = generate_launch_id(None);
        assert!(without.starts_with("box-"));
        assert!(!without.starts_with("box-hooksmith"));
        // Always a random suffix → two calls differ.
        assert_ne!(generate_launch_id(None), generate_launch_id(None));
    }
}
