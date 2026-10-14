/// Reading what ChemDraw puts on the clipboard.
///
/// On Windows, a plain Ctrl+C in ChemDraw does not fill `CF_UNICODETEXT`; it writes custom
/// registered clipboard formats instead, and their names differ between ChemDraw versions. So
/// rather than trusting a name, every registered format on the clipboard is read and searched for
/// CDXML (an XML document, possibly behind a header) or a Molfile (plain, or MDLCT's
/// length-prefixed lines).
mod chemdraw {
    // The decoders are plain functions over bytes so they can be tested on any OS; only the
    // clipboard access itself is Windows-specific.
    #![cfg_attr(not(windows), allow(dead_code))]

    /// Blocks of this size or more are skipped: pictures and embedded documents, not structures.
    const MAX_BLOCK: usize = 10 * 1024 * 1024;
    /// How far before `<CDXML` the `<?xml` / `<!DOCTYPE` prolog may start and still belong to it.
    const PROLOG_WINDOW: usize = 4096;
    const CDXML_END: &str = "</CDXML>";

    fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack.windows(needle.len()).position(|window| window == needle)
    }

    fn utf16le(text: &str) -> Vec<u8> {
        text.encode_utf16().flat_map(|unit| unit.to_le_bytes()).collect()
    }

    /// `bytes` as text in which `<CDXML` can be searched: read as UTF-8, or as UTF-16LE when
    /// that is the encoding the tag is found in. `None` if the tag is in neither.
    fn text_containing_cdxml(bytes: &[u8]) -> Option<String> {
        if find_bytes(bytes, b"<CDXML").is_some() {
            return Some(String::from_utf8_lossy(bytes).into_owned());
        }
        let at = find_bytes(bytes, &utf16le("<CDXML"))?;
        // Start on the same byte parity as the tag so the 16-bit units line up.
        let units: Vec<u16> = bytes[at % 2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        Some(String::from_utf16_lossy(&units))
    }

    /// The CDXML document inside `bytes`, from its `<?xml` / `<!DOCTYPE` prolog (or `<CDXML` if
    /// there is none) through `</CDXML>`. Anything ChemDraw puts before or after is dropped.
    pub fn extract_cdxml(bytes: &[u8]) -> Option<String> {
        let text = text_containing_cdxml(bytes)?;
        let root = text.find("<CDXML")?;
        let head = &text[..root];
        let start = [head.rfind("<?xml"), head.rfind("<!DOCTYPE")]
            .into_iter()
            .flatten()
            .filter(|&at| root - at <= PROLOG_WINDOW)
            .min()
            .unwrap_or(root);
        let end = text[root..]
            .rfind(CDXML_END)
            .map(|at| root + at + CDXML_END.len())
            .unwrap_or_else(|| text.trim_end_matches('\0').len());
        Some(text[start..end].to_owned())
    }

    /// Decode bytes (UTF-8, or UTF-16 with a BOM) into text without trailing NULs.
    fn decode_text(bytes: &[u8]) -> String {
        if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
            let units: Vec<u16> = rest
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            return String::from_utf16_lossy(&units).trim_end_matches('\0').to_owned();
        }
        let end = bytes.iter().rposition(|&b| b != 0).map_or(0, |last| last + 1);
        String::from_utf8_lossy(&bytes[..end]).into_owned()
    }

    /// Split a length-prefixed block (each line preceded by one byte holding its length) into
    /// lines. `None` if a prefix points past the end of the data.
    fn split_length_prefixed(bytes: &[u8]) -> Option<Vec<String>> {
        let mut lines = Vec::new();
        let mut pos = 0;
        while pos < bytes.len() {
            let len = bytes[pos] as usize;
            let line = bytes.get(pos + 1..pos + 1 + len)?;
            let text = String::from_utf8_lossy(line);
            let text = text.trim_end_matches(['\0', '\r', '\n']).to_owned();
            let done = text.trim_end() == "M  END";
            lines.push(text);
            if done {
                break; // everything after the end marker is padding
            }
            pos += 1 + len;
        }
        Some(lines)
    }

    /// A standard Molfile from ChemDraw's MDLCT data. The normal layout is length-prefixed lines;
    /// if the block turns out to be an ordinary text Molfile, that is accepted too.
    pub fn parse_mdlct(bytes: &[u8]) -> Option<String> {
        if let Some(lines) = split_length_prefixed(bytes) {
            if lines.last().is_some_and(|line| line.trim_end() == "M  END") {
                return Some(lines.join("\n") + "\n");
            }
        }
        let text = decode_text(bytes);
        let end = text.find("M  END")?;
        let molfile = text[..end].replace("\r\n", "\n") + "M  END\n";
        Some(molfile)
    }

    /// The SMILES string in ChemDraw's `SMILES` clipboard format. It is plain text, possibly
    /// NUL-padded (or UTF-16, whose NULs vanish with the rest), and in some builds preceded by one
    /// length byte; that byte is skipped when it equals the number of bytes after it.
    pub fn decode_smiles(bytes: &[u8]) -> Option<String> {
        let end = bytes.iter().rposition(|&b| b != 0).map_or(0, |last| last + 1);
        let mut data = &bytes[..end];
        if let Some((&first, rest)) = data.split_first() {
            if first != 0 && first < 0x20 && first as usize == rest.len() {
                data = rest;
            }
        }
        let text: Vec<u8> = data.iter().copied().filter(|&b| b != 0).collect();
        let smiles = String::from_utf8_lossy(&text).trim().to_owned();
        (!smiles.is_empty()).then_some(smiles)
    }

    /// The best structure among `(format name, bytes)` clipboard blocks, in this order:
    /// 1. the `SMILES` format (any letter case);
    /// 2. CDXML from any block;
    /// 3. a Molfile from a block named like one (MDLCT, mol, ctab) or holding an `M  END` line.
    ///
    /// Molfiles are fixed-layout (title, program and comment lines, then the counts line as line 4,
    /// with leading spaces that matter), so their text is never trimmed at the start.
    pub fn pick_structure(blocks: &[(String, Vec<u8>)]) -> Option<String> {
        let smiles = blocks
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("smiles"))
            .find_map(|(_, bytes)| decode_smiles(bytes));
        if let Some(smiles) = smiles {
            println!("[ChemDraw Clipboard] Found SMILES format: {smiles}");
            return Some(smiles);
        }
        if let Some(cdxml) = blocks.iter().find_map(|(_, bytes)| extract_cdxml(bytes)) {
            println!("[ChemDraw Clipboard] Found CDXML ({} characters)", cdxml.len());
            return Some(cdxml);
        }
        blocks.iter().find_map(|(name, bytes)| {
            let name = name.to_ascii_lowercase();
            let molfile_like = ["mdlct", "mol", "ctab"].iter().any(|key| name.contains(key))
                || find_bytes(bytes, b"M  END").is_some();
            let molfile = if molfile_like { parse_mdlct(bytes) } else { None }?;
            let head: Vec<&str> = molfile.lines().take(4).collect();
            println!("[ChemDraw Clipboard] Found Molfile, first 4 lines: {head:?}");
            Some(molfile)
        })
    }

    /// Walk every format on the clipboard (logging each, so `tauri dev` shows what ChemDraw
    /// offers), read the registered ones, and return the structure in them, if any. `None` when
    /// there is none or the clipboard is busy.
    #[cfg(windows)]
    pub fn read() -> Option<String> {
        use clipboard_win::{raw, Clipboard};

        // Held for the whole read; released when it drops.
        let _clip = Clipboard::new_attempts(10).ok()?;

        let mut blocks: Vec<(String, Vec<u8>)> = Vec::new();
        for format in raw::EnumFormats::new() {
            let name = raw::format_name_big(format);
            println!("[Clipboard Format] id={} name={:?}", format, name);
            // Below 0xC000 are Windows' own formats (text, bitmaps, ...); the webview reads text.
            if format < 0xC000 {
                continue;
            }
            let size = raw::size(format).map_or(0, |size| size.get());
            if size == 0 || size >= MAX_BLOCK {
                continue;
            }
            let mut bytes = Vec::with_capacity(size);
            if raw::get_vec(format, &mut bytes).is_ok() {
                blocks.push((name.unwrap_or_default(), bytes));
            }
        }
        pick_structure(&blocks)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn prefixed(lines: &[&str]) -> Vec<u8> {
            lines
                .iter()
                .flat_map(|line| std::iter::once(line.len() as u8).chain(line.bytes()))
                .collect()
        }

        fn block(name: &str, bytes: &[u8]) -> (String, Vec<u8>) {
            (name.to_owned(), bytes.to_vec())
        }

        #[test]
        fn cdxml_is_extracted_and_nul_trimmed() {
            let mut bytes = b"<?xml version=\"1.0\"?><CDXML><page/></CDXML>".to_vec();
            bytes.extend([0, 0, 0]);
            let xml = extract_cdxml(&bytes).unwrap();
            assert_eq!(xml, "<?xml version=\"1.0\"?><CDXML><page/></CDXML>");
        }

        #[test]
        fn header_and_trailer_around_cdxml_are_dropped() {
            let mut bytes = vec![0x01, 0x00, 0xFF, 0xFE, b'x']; // binary header
            bytes.extend(
                b"<?xml version=\"1.0\"?><!DOCTYPE CDXML SYSTEM \"x.dtd\"><CDXML><page/></CDXML>",
            );
            bytes.extend(b"\0\0trailing junk\0");
            let xml = extract_cdxml(&bytes).unwrap();
            assert!(xml.starts_with("<?xml version"));
            assert!(xml.ends_with("</CDXML>"));
            assert!(!xml.contains("junk"));
        }

        #[test]
        fn cdxml_without_prolog_starts_at_the_root() {
            let xml = extract_cdxml(b"HEADER<CDXML><page/></CDXML>").unwrap();
            assert_eq!(xml, "<CDXML><page/></CDXML>");
        }

        #[test]
        fn utf16_cdxml_is_extracted_even_at_an_odd_offset() {
            let mut bytes = vec![0xAA]; // shifts everything to an odd offset
            bytes.extend(utf16le("<?xml version=\"1.0\"?><CDXML><page/></CDXML>"));
            assert_eq!(
                extract_cdxml(&bytes).unwrap(),
                "<?xml version=\"1.0\"?><CDXML><page/></CDXML>"
            );
        }

        #[test]
        fn other_xml_is_rejected() {
            assert!(extract_cdxml(b"<html><body/></html>").is_none());
            assert!(extract_cdxml(b"<!DOCTYPE CDXML SYSTEM \"x.dtd\">").is_none());
            assert!(extract_cdxml(&[]).is_none());
        }

        #[test]
        fn mdlct_lines_become_a_molfile() {
            let mut bytes = prefixed(&[
                "ethanol",
                "  ChemDraw",
                "",
                "  3  2  0  0  0  0  0  0  0  0999 V2000",
                "M  END",
            ]);
            bytes.extend([0, 0, 0, 0]); // clipboard padding
            let molfile = parse_mdlct(&bytes).unwrap();
            assert_eq!(
                molfile,
                "ethanol\n  ChemDraw\n\n  3  2  0  0  0  0  0  0  0  0999 V2000\nM  END\n"
            );
        }

        #[test]
        fn plain_text_molfile_is_accepted() {
            let molfile = parse_mdlct(b"\nChemDraw\n\n  0  0  0  0  0  0  0  0  0  0999 V2000\r\nM  END\r\n\0\0")
                .unwrap();
            assert!(molfile.ends_with("V2000\nM  END\n"));
        }

        #[test]
        fn broken_mdlct_is_rejected() {
            assert!(parse_mdlct(&[200, b'a', b'b']).is_none()); // prefix points past the end
            assert!(parse_mdlct(&prefixed(&["no end marker here"])).is_none());
            assert!(parse_mdlct(&[]).is_none());
        }

        #[test]
        fn smiles_is_decoded_from_the_variants_chemdraw_may_use() {
            assert_eq!(decode_smiles(b"CC(=O)O").unwrap(), "CC(=O)O");
            assert_eq!(decode_smiles(b"CC(=O)O\0\0\0").unwrap(), "CC(=O)O");
            assert_eq!(decode_smiles(b"  c1ccccc1\r\n\0").unwrap(), "c1ccccc1");
            // one length byte in front (7 = bytes after it), with padding
            assert_eq!(decode_smiles(b"\x07CC(=O)O\0\0").unwrap(), "CC(=O)O");
            // UTF-16LE text: the NULs are dropped
            assert_eq!(decode_smiles(&utf16le("CCO")).unwrap(), "CCO");
            assert!(decode_smiles(b"\0\0\0").is_none());
            assert!(decode_smiles(b"  \r\n").is_none());
        }

        #[test]
        fn smiles_format_comes_first_whatever_its_letter_case() {
            let mdlct = prefixed(&["", "", "", "  0  0  0  0  0  0  0  0  0  0999 V2000", "M  END"]);
            let blocks = [
                block("MDLCT", &mdlct),
                block("CDXML", b"<CDXML><page/></CDXML>"),
                block("Smiles", b"CCO\0"),
            ];
            assert_eq!(pick_structure(&blocks).unwrap(), "CCO");
            // an empty SMILES slot does not hide the structure behind it
            let blocks = [block("SMILES", b"\0\0"), block("CDXML", b"<CDXML><page/></CDXML>")];
            assert!(pick_structure(&blocks).unwrap().starts_with("<CDXML"));
        }

        #[test]
        fn molfile_keeps_empty_header_lines_and_leading_spaces() {
            let counts = "  2  1  0  0  0  0  0  0  0  0999 V2000";
            let atom1 = "    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0";
            let bytes = prefixed(&["", "", "", counts, atom1, "M  END"]);
            let molfile = parse_mdlct(&bytes).unwrap();
            let lines: Vec<&str> = molfile.lines().collect();
            assert_eq!(&lines[..3], ["", "", ""], "header lines stay empty, not skipped");
            assert_eq!(lines[3], counts, "the counts line is line 4, leading spaces intact");
            assert_eq!(lines[4], atom1);
            assert!(molfile.starts_with("\n\n\n  2  1"));
            // through the picker as well
            let picked = pick_structure(&[block("MDLCT", &bytes)]).unwrap();
            assert_eq!(picked, molfile);
        }

        #[test]
        fn cdxml_wins_over_a_molfile_and_any_format_name_works() {
            let mdlct = prefixed(&["", "", "", "  0  0  0  0  0  0  0  0  0  0999 V2000", "M  END"]);
            let blocks = [
                block("MDLCT", &mdlct),
                block("Some Odd ChemDraw Name", b"..<CDXML><page/></CDXML>"),
            ];
            assert!(pick_structure(&blocks).unwrap().starts_with("<CDXML"));
        }

        #[test]
        fn molfile_is_found_by_name_or_by_content() {
            let mdlct = prefixed(&["", "", "", "  0  0  0  0  0  0  0  0  0  0999 V2000", "M  END"]);
            assert!(pick_structure(&[block("MDLCT", &mdlct)]).unwrap().ends_with("M  END\n"));
            assert!(pick_structure(&[block("Whatever", &mdlct)]).unwrap().ends_with("M  END\n"));
            assert!(pick_structure(&[block("Embed Source", b"binary stuff")]).is_none());
            assert!(pick_structure(&[]).is_none());
        }

        /// Writes ChemDraw-style formats to the real clipboard and reads them back.
        #[cfg(windows)]
        #[test]
        #[ignore = "uses the real Windows clipboard; run with --ignored"]
        fn windows_clipboard_roundtrip() {
            use clipboard_win::{raw, Clipboard};

            // CDXML under a name we have never heard of, behind a header.
            let cdxml = b"HDR\0<?xml version=\"1.0\"?><CDXML><page/></CDXML>\0";
            let format = raw::register_format("Fumebook Test Format").unwrap().get();
            {
                let _clip = Clipboard::new_attempts(10).unwrap();
                raw::empty().unwrap();
                raw::set_without_clear(format, cdxml).unwrap();
            }
            assert!(read().unwrap().starts_with("<?xml"));

            let mdlct = prefixed(&["", "", "", "  0  0  0  0  0  0  0  0  0  0999 V2000", "M  END"]);
            let format = raw::register_format("MDLCT").unwrap().get();
            {
                let _clip = Clipboard::new_attempts(10).unwrap();
                raw::empty().unwrap();
                raw::set_without_clear(format, &mdlct).unwrap();
            }
            assert!(read().unwrap().contains("M  END"));

            // ChemDraw's normal Ctrl+C: MDLCT and SMILES side by side; SMILES is what we return.
            let smiles = raw::register_format("SMILES").unwrap().get();
            {
                let _clip = Clipboard::new_attempts(10).unwrap();
                raw::set_without_clear(smiles, b"CCO\0").unwrap();
            }
            assert_eq!(read().unwrap(), "CCO");
        }
    }
}

/// The ChemDraw structure on the clipboard as CDXML or Molfile text, for the sketcher's Ctrl+V.
/// Only Windows has ChemDraw's custom clipboard formats; everywhere else this is `None`.
///
/// No capability entry is needed for this: Tauri v2 only gates plugin commands and commands
/// listed in an `AppManifest`; app commands registered in `generate_handler!` are open to the
/// app's own webview (`build.rs` declares no manifest).
#[tauri::command]
fn read_chemdraw_clipboard() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        chemdraw::read()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// Why `path` may not be handed to the system opener, or `None` if it is fine.
///
/// The command is reachable from the webview, so it only ever opens an existing `.cdxml` file
/// (never an arbitrary program), and the path must be free of the characters `cmd` would still
/// interpret inside quotes.
fn cdxml_path_problem(path: &str) -> Option<String> {
    let p = std::path::Path::new(path);
    let is_cdxml = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cdxml"));
    if !is_cdxml {
        return Some("Only .cdxml files can be opened in ChemDraw.".into());
    }
    if path.chars().any(|c| c == '"' || c == '%' || c.is_control()) {
        return Some(format!("The path contains a character that cannot be opened safely: {path}"));
    }
    if !p.is_file() {
        return Some(format!("The file does not exist: {path}"));
    }
    None
}

/// Open a `.cdxml` file in the user's default application for it (ChemDraw, when installed).
/// On Windows this is `cmd /C start "" "<path>"`. Like `read_chemdraw_clipboard`, this app command
/// needs no capability entry.
#[tauri::command]
fn open_in_chemdraw(path: String) -> Result<(), String> {
    if let Some(problem) = cdxml_path_problem(&path) {
        return Err(problem);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // `raw_arg` so the path is quoted exactly once, by us: paths with `&` or spaces stay
        // one argument for `start`. The empty "" is `start`'s window-title slot.
        std::process::Command::new("cmd")
            .args(["/C", "start", ""])
            .raw_arg(format!("\"{path}\""))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Could not start the default app for .cdxml files: {e}"))
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Could not open {path}: {e}"))
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Could not open {path}: {e}"))
    }
}

#[cfg(test)]
mod open_tests {
    use super::cdxml_path_problem;

    #[test]
    fn only_existing_cdxml_files_are_accepted() {
        assert!(cdxml_path_problem("C:\\x\\scheme.txt").is_some());
        assert!(cdxml_path_problem("C:\\x\\scheme.cdxml").is_some()); // does not exist
        assert!(cdxml_path_problem("C:\\x\\sch\"eme.cdxml").is_some());
        assert!(cdxml_path_problem("C:\\x\\%PATH%.cdxml").is_some());
        let file = std::env::temp_dir().join("fumebook_open_test.cdxml");
        std::fs::write(&file, "<CDXML/>").unwrap();
        assert!(cdxml_path_problem(file.to_str().unwrap()).is_none());
        std::fs::remove_file(file).ok();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![read_chemdraw_clipboard, open_in_chemdraw])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
