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
    /// 1. CDXML from any block (preserves 2D/3D perspective coordinates, `<colortable>`, and `<curve>` splines);
    /// 2. a Molfile from a block named like one (MDLCT, mol, ctab) or holding an `M  END` line
    ///    (preserves 2D/3D perspective coordinates and wedge/hash bond stereochemistry);
    /// 3. the `SMILES` format (any letter case) as a 1D fallback when neither CDXML nor Molfile is present.
    ///
    /// Molfiles are fixed-layout (title, program and comment lines, then the counts line as line 4,
    /// with leading spaces that matter), so their text is never trimmed at the start.
    pub fn pick_structure(blocks: &[(String, Vec<u8>)]) -> Option<String> {
        if let Some(cdxml) = pick_cdxml(blocks) {
            println!("[ChemDraw Clipboard] Found CDXML ({} characters)", cdxml.len());
            return Some(cdxml);
        }
        if let Some(molfile) = pick_molfile(blocks) {
            let head: Vec<&str> = molfile.lines().take(4).collect();
            println!("[ChemDraw Clipboard] Found Molfile, first 4 lines: {head:?}");
            return Some(molfile);
        }
        if let Some(smiles) = pick_smiles(blocks) {
            println!("[ChemDraw Clipboard] Found SMILES format: {smiles}");
            return Some(smiles);
        }
        None
    }

    pub fn pick_cdxml(blocks: &[(String, Vec<u8>)]) -> Option<String> {
        blocks.iter().find_map(|(_, bytes)| extract_cdxml(bytes))
    }

    pub fn pick_molfile(blocks: &[(String, Vec<u8>)]) -> Option<String> {
        blocks.iter().find_map(|(name, bytes)| {
            let name = name.to_ascii_lowercase();
            let molfile_like = ["mdlct", "mol", "ctab"].iter().any(|key| name.contains(key))
                || find_bytes(bytes, b"M  END").is_some();
            if molfile_like {
                parse_mdlct(bytes)
            } else {
                None
            }
        })
    }

    pub fn pick_smiles(blocks: &[(String, Vec<u8>)]) -> Option<String> {
        blocks
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("smiles"))
            .find_map(|(_, bytes)| decode_smiles(bytes))
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

    /// If `CF_ENHMETAFILE` (`format = 14`, placed on the Windows clipboard by ChemDraw on `Ctrl+C`)
    /// is available, replay it via Win32 GDI `PlayEnhMetaFile` onto a white 32-bit DIB and return
    /// `(width, height, rgba_bytes)`.
    #[cfg(windows)]
    pub fn render_clipboard_emf_to_rgba() -> Option<(u32, u32, Vec<u8>)> {
        use clipboard_win::Clipboard;
        use core::ffi::c_void;
        use core::ptr::null_mut;

        const CF_ENHMETAFILE: u32 = 14;
        const DIB_RGB_COLORS: u32 = 0;

        #[repr(C)]
        #[derive(Clone, Copy, Default)]
        struct RECT {
            left: i32,
            top: i32,
            right: i32,
            bottom: i32,
        }

        #[repr(C)]
        #[derive(Clone, Copy, Default)]
        struct SIZEL {
            cx: i32,
            cy: i32,
        }

        #[repr(C)]
        #[derive(Clone, Copy, Default)]
        struct ENHMETAHEADER {
            i_type: u32,
            n_size: u32,
            rcl_bounds: RECT,
            rcl_frame: RECT,
            d_signature: u32,
            n_version: u32,
            n_bytes: u32,
            n_records: u32,
            n_handles: u16,
            s_reserved: u16,
            n_description: u32,
            off_description: u32,
            n_pal_entries: u32,
            szl_device: SIZEL,
            szl_millimeters: SIZEL,
            cb_pixel_format: u32,
            off_pixel_format: u32,
            b_open_gl: u32,
            szl_micrometers: SIZEL,
        }

        #[repr(C)]
        #[derive(Clone, Copy, Default)]
        struct BITMAPINFOHEADER {
            bi_size: u32,
            bi_width: i32,
            bi_height: i32,
            bi_planes: u16,
            bi_bit_count: u16,
            bi_compression: u32,
            bi_size_image: u32,
            bi_x_pels_per_meter: i32,
            bi_y_pels_per_meter: i32,
            bi_clr_used: u32,
            bi_clr_important: u32,
        }

        #[link(name = "user32")]
        unsafe extern "system" {
            fn GetClipboardData(u_format: u32) -> *mut c_void;
        }

        #[link(name = "gdi32")]
        unsafe extern "system" {
            fn GetEnhMetaFileHeader(
                hemf: *mut c_void,
                n_size: u32,
                lp_enh_meta_header: *mut ENHMETAHEADER,
            ) -> u32;
            fn CreateCompatibleDC(hdc: *mut c_void) -> *mut c_void;
            fn DeleteDC(hdc: *mut c_void) -> i32;
            fn CreateDIBSection(
                hdc: *mut c_void,
                pbmi: *const BITMAPINFOHEADER,
                usage: u32,
                ppv_bits: *mut *mut u8,
                h_section: *mut c_void,
                offset: u32,
            ) -> *mut c_void;
            fn SelectObject(hdc: *mut c_void, h: *mut c_void) -> *mut c_void;
            fn DeleteObject(ho: *mut c_void) -> i32;
            fn PlayEnhMetaFile(hdc: *mut c_void, hemf: *mut c_void, lprect: *const RECT) -> i32;
            fn GdiFlush() -> i32;
        }

        let _clip = Clipboard::new_attempts(10).ok()?;

        unsafe {
            let hemf = GetClipboardData(CF_ENHMETAFILE);
            if hemf.is_null() {
                return None;
            }

            let mut hdr = ENHMETAHEADER::default();
            let got = GetEnhMetaFileHeader(
                hemf,
                core::mem::size_of::<ENHMETAHEADER>() as u32,
                &mut hdr,
            );
            if got == 0 {
                return None;
            }

            let frame_w = (hdr.rcl_frame.right - hdr.rcl_frame.left).max(0) as f64;
            let frame_h = (hdr.rcl_frame.bottom - hdr.rcl_frame.top).max(0) as f64;
            let bounds_w = (hdr.rcl_bounds.right - hdr.rcl_bounds.left).max(0) as f64;
            let bounds_h = (hdr.rcl_bounds.bottom - hdr.rcl_bounds.top).max(0) as f64;

            // rcl_frame is in 0.01 mm units (2540 units = 1 inch). Render at 300 DPI.
            let (raw_w, raw_h) = if frame_w > 10.0 && frame_h > 10.0 {
                (frame_w * 300.0 / 2540.0, frame_h * 300.0 / 2540.0)
            } else if bounds_w > 1.0 && bounds_h > 1.0 {
                (bounds_w * 3.0, bounds_h * 3.0)
            } else {
                return None;
            };

            let max_edge = raw_w.max(raw_h).max(1.0);
            let scale = if max_edge > 2200.0 {
                2200.0 / max_edge
            } else if max_edge < 600.0 {
                (900.0 / max_edge).min(4.0)
            } else {
                1.0
            };

            let draw_w = (raw_w * scale).round().clamp(64.0, 2400.0) as i32;
            let draw_h = (raw_h * scale).round().clamp(64.0, 2400.0) as i32;
            let pad = 24i32;
            let canvas_w = draw_w + pad * 2;
            let canvas_h = draw_h + pad * 2;

            let hdc = CreateCompatibleDC(null_mut());
            if hdc.is_null() {
                return None;
            }

            let bmi = BITMAPINFOHEADER {
                bi_size: core::mem::size_of::<BITMAPINFOHEADER>() as u32,
                bi_width: canvas_w,
                bi_height: -canvas_h, // top-down DIB
                bi_planes: 1,
                bi_bit_count: 32,
                bi_compression: 0,
                bi_size_image: (canvas_w * canvas_h * 4) as u32,
                bi_x_pels_per_meter: 11811,
                bi_y_pels_per_meter: 11811,
                bi_clr_used: 0,
                bi_clr_important: 0,
            };

            let mut bits_ptr: *mut u8 = null_mut();
            let hbmp = CreateDIBSection(
                hdc,
                &bmi,
                DIB_RGB_COLORS,
                &mut bits_ptr,
                null_mut(),
                0,
            );
            if hbmp.is_null() || bits_ptr.is_null() {
                DeleteDC(hdc);
                return None;
            }

            let old_obj = SelectObject(hdc, hbmp);
            let total_bytes = (canvas_w as usize) * (canvas_h as usize) * 4;
            core::slice::from_raw_parts_mut(bits_ptr, total_bytes).fill(0xFF);

            let target_rect = RECT {
                left: pad,
                top: pad,
                right: pad + draw_w,
                bottom: pad + draw_h,
            };
            let played = PlayEnhMetaFile(hdc, hemf, &target_rect);
            GdiFlush();

            let out = if played != 0 {
                let bgra = core::slice::from_raw_parts(bits_ptr, total_bytes);
                let mut rgba = Vec::with_capacity(total_bytes);
                let mut has_non_white = false;
                for px in bgra.chunks_exact(4) {
                    let b = px[0];
                    let g = px[1];
                    let r = px[2];
                    if r < 252 || g < 252 || b < 252 {
                        has_non_white = true;
                    }
                    rgba.push(r);
                    rgba.push(g);
                    rgba.push(b);
                    rgba.push(255);
                }
                if has_non_white {
                    Some((canvas_w as u32, canvas_h as u32, rgba))
                } else {
                    None
                }
            } else {
                None
            };

            SelectObject(hdc, old_obj);
            DeleteObject(hbmp);
            DeleteDC(hdc);
            out
        }
    }

    fn utf16_clipboard_text(text: &str) -> Vec<u8> {
        let mut bytes = utf16le(text);
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes
    }

    /// ChemDraw's MDLCT block: each line is a length byte followed by that many bytes.
    fn mdlct_bytes(molfile: &str) -> Vec<u8> {
        let mut out = Vec::new();
        for line in molfile.split('\n') {
            let line = line.trim_end_matches('\r');
            let raw = line.as_bytes();
            let len = raw.len().min(255);
            out.push(len as u8);
            out.extend_from_slice(&raw[..len]);
        }
        out
    }

    /// A bottom-up 32-bit `CF_DIB` (BITMAPINFOHEADER + BGRA pixels) from PNG bytes.
    fn png_bytes_to_dib(png: &[u8]) -> Result<Vec<u8>, String> {
        let img = image::load_from_memory(png)
            .map_err(|e| e.to_string())?
            .to_rgba8();
        let width = img.width() as i32;
        let height = img.height() as i32;
        if width <= 0 || height <= 0 {
            return Err("Clipboard image has no pixels.".into());
        }
        let mut dib = Vec::with_capacity(40 + (width as usize) * (height as usize) * 4);
        dib.extend_from_slice(&40u32.to_le_bytes());
        dib.extend_from_slice(&width.to_le_bytes());
        dib.extend_from_slice(&height.to_le_bytes());
        dib.extend_from_slice(&1u16.to_le_bytes());
        dib.extend_from_slice(&32u16.to_le_bytes());
        dib.extend_from_slice(&0u32.to_le_bytes());
        let size_image = (width as u32) * (height as u32) * 4;
        dib.extend_from_slice(&size_image.to_le_bytes());
        dib.extend_from_slice(&0i32.to_le_bytes());
        dib.extend_from_slice(&0i32.to_le_bytes());
        dib.extend_from_slice(&0u32.to_le_bytes());
        dib.extend_from_slice(&0u32.to_le_bytes());
        for y in (0..height).rev() {
            for x in 0..width {
                let pixel = img.get_pixel(x as u32, y as u32);
                dib.push(pixel[2]);
                dib.push(pixel[1]);
                dib.push(pixel[0]);
                dib.push(pixel[3]);
            }
        }
        Ok(dib)
    }

    /// Exact PNG or BMP file bytes from a registered clipboard format (`PNG`, `image/png`, `BMP`).
    /// Standard formats such as `CF_DIB` are left for the EMF renderer and `arboard`.
    #[cfg(windows)]
    pub fn read_raster_clipboard_bytes() -> Option<Vec<u8>> {
        use clipboard_win::{raw, Clipboard};

        let _clip = Clipboard::new_attempts(10).ok()?;
        for format in raw::EnumFormats::new() {
            if format < 0xC000 {
                continue;
            }
            let name = raw::format_name_big(format).unwrap_or_default();
            let lname = name.to_ascii_lowercase();
            if !lname.contains("png") && !lname.contains("bmp") {
                continue;
            }
            let size = raw::size(format).map_or(0, |size| size.get());
            if size < 8 || size >= MAX_BLOCK {
                continue;
            }
            let mut bytes = Vec::with_capacity(size);
            if raw::get_vec(format, &mut bytes).is_err() {
                continue;
            }
            if bytes.starts_with(b"\x89PNG") || bytes.starts_with(b"BM") {
                return Some(bytes);
            }
        }
        None
    }

    /// Put a structure image and its CDXML / Molfile / SMILES on the clipboard together,
    /// so Word and PowerPoint paste the picture and ChemDraw pastes the structure.
    #[cfg(windows)]
    pub fn write_image_and_text(png_bytes: &[u8], text: &str) -> Result<(), String> {
        use clipboard_win::{raw, Clipboard};

        let _clip = Clipboard::new_attempts(10).map_err(|e| e.to_string())?;
        raw::empty().map_err(|e| e.to_string())?;

        if !png_bytes.is_empty() {
            let dib = png_bytes_to_dib(png_bytes)?;
            // CF_DIB = 8. Word and PowerPoint paste this bitmap.
            raw::set_without_clear(8, &dib).map_err(|e| e.to_string())?;
            if let Some(fmt) = raw::register_format("PNG") {
                raw::set_without_clear(fmt.get(), png_bytes).map_err(|e| e.to_string())?;
            }
        }

        if !text.is_empty() {
            raw::set_without_clear(13, &utf16_clipboard_text(text))
                .map_err(|e| e.to_string())?;
            if text.contains("<CDXML") {
                if let Some(fmt) = raw::register_format("CDXML") {
                    let mut bytes = text.as_bytes().to_vec();
                    bytes.push(0);
                    raw::set_without_clear(fmt.get(), &bytes).map_err(|e| e.to_string())?;
                }
            } else if text.contains("M  END") {
                if let Some(fmt) = raw::register_format("MDLCT") {
                    raw::set_without_clear(fmt.get(), &mdlct_bytes(text))
                        .map_err(|e| e.to_string())?;
                }
            } else if let Some(fmt) = raw::register_format("SMILES") {
                let mut bytes = text.as_bytes().to_vec();
                bytes.push(0);
                raw::set_without_clear(fmt.get(), &bytes).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
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
        fn cdxml_and_molfile_come_before_smiles_to_preserve_3d_coordinates() {
            let mdlct = prefixed(&["", "", "", "  0  0  0  0  0  0  0  0  0  0999 V2000", "M  END"]);
            // When CDXML, MDLCT, and SMILES are all present, CDXML wins first
            let blocks = [
                block("Smiles", b"CCO\0"),
                block("MDLCT", &mdlct),
                block("CDXML", b"<CDXML><page/></CDXML>"),
            ];
            assert!(pick_structure(&blocks).unwrap().starts_with("<CDXML"));

            // When MDLCT and SMILES are present (like ChemDraw Ctrl+C on cyclodextrins), MDLCT wins over 1D SMILES
            let blocks_no_cdxml = [
                block("Smiles", b"CCO\0"),
                block("MDLCT", &mdlct),
            ];
            assert!(pick_structure(&blocks_no_cdxml).unwrap().ends_with("M  END\n"));

            // When only SMILES is present, SMILES is returned
            let blocks_only_smiles = [block("Smiles", b"CCO\0")];
            assert_eq!(pick_structure(&blocks_only_smiles).unwrap(), "CCO");
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

            // ChemDraw's normal Ctrl+C: MDLCT and SMILES side by side; MDLCT (with coordinates) wins over 1D SMILES.
            let smiles = raw::register_format("SMILES").unwrap().get();
            {
                let _clip = Clipboard::new_attempts(10).unwrap();
                raw::set_without_clear(smiles, b"CCO\0").unwrap();
            }
            assert!(read().unwrap().contains("M  END"));
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

fn rgba_to_png_data_url(width: u32, height: u32, rgba_bytes: Vec<u8>) -> Result<String, String> {
    let mut buffer = std::io::Cursor::new(Vec::new());
    let dynamic_image = image::DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(width, height, rgba_bytes).ok_or("Failed to construct image")?,
    );
    dynamic_image
        .write_to(&mut buffer, image::ImageOutputFormat::Png)
        .map_err(|e| e.to_string())?;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(buffer.into_inner())
    ))
}

fn png_file_to_data_url(bytes: &[u8]) -> Result<String, String> {
    if bytes.starts_with(b"\x89PNG") {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        return Ok(format!("data:image/png;base64,{}", STANDARD.encode(bytes)));
    }
    let img = image::load_from_memory(bytes)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let (width, height) = img.dimensions();
    rgba_to_png_data_url(width, height, img.into_raw())
}

fn decode_png_base64(raw: &str) -> Result<Vec<u8>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let b64 = trimmed.rsplit(',').next().unwrap_or(trimmed);
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("Could not read the structure image: {e}"))
}

/// The picture ChemDraw (or another app) put on the clipboard, as a PNG data URL.
///
/// Windows order: exact `PNG`/`BMP` bytes, then `CF_ENHMETAFILE` (colored cartoons such as
/// cyclodextrin ring fills), then the bitmap `arboard` can see. A monochrome DIB must not
/// hide the colored metafile, and this picture is never redrawn by Indigo.
#[tauri::command]
fn read_clipboard_image_base64() -> Result<String, String> {
    #[cfg(windows)]
    if let Some(bytes) = chemdraw::read_raster_clipboard_bytes() {
        println!(
            "[ChemDraw Clipboard] Using exact clipboard raster ({} bytes)",
            bytes.len()
        );
        return png_file_to_data_url(&bytes);
    }

    #[cfg(windows)]
    if let Some((width, height, rgba)) = chemdraw::render_clipboard_emf_to_rgba() {
        println!("[ChemDraw Clipboard] Rendered CF_ENHMETAFILE to {width}x{height} RGBA PNG");
        return rgba_to_png_data_url(width, height, rgba);
    }

    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let image_data = clipboard.get_image().map_err(|e| e.to_string())?;
    let width: u32 = image_data
        .width
        .try_into()
        .map_err(|_| "Invalid image width".to_string())?;
    let height: u32 = image_data
        .height
        .try_into()
        .map_err(|_| "Invalid image height".to_string())?;
    rgba_to_png_data_url(width, height, image_data.bytes.into_owned())
}

/// Copy a structure drawing out of the notebook: PNG (for Word / PowerPoint) plus
/// CDXML, Molfile, or SMILES (for ChemDraw).
#[tauri::command]
fn write_structure_clipboard(png_base64: String, text: String) -> Result<(), String> {
    let png_bytes = decode_png_base64(&png_base64)?;
    #[cfg(windows)]
    {
        chemdraw::write_image_and_text(&png_bytes, &text)
    }
    #[cfg(not(windows))]
    {
        if !png_bytes.is_empty() {
            let img = image::load_from_memory(&png_bytes)
                .map_err(|e| e.to_string())?
                .to_rgba8();
            let (width, height) = img.dimensions();
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            clipboard
                .set_image(arboard::ImageData {
                    width: width as usize,
                    height: height as usize,
                    bytes: std::borrow::Cow::Owned(img.into_raw()),
                })
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
        if !text.is_empty() {
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            clipboard.set_text(text).map_err(|e| e.to_string())?;
        }
        Ok(())
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

/// Wait briefly (up to 3 retries: 50ms, 100ms, 200ms) if the `.cdxml` file is still being
/// flushed or scanned by Windows Defender right after writing, ensuring all handles in our
/// process are closed before handing the path to `cmd /C start`.
fn wait_for_cdxml_unlocked(path: &str) {
    let delays_ms = [50_u64, 100, 200];
    for delay in delays_ms {
        let can_open = {
            // File handle is scoped to this block and dropped immediately.
            std::fs::OpenOptions::new().read(true).open(path).is_ok()
        };
        if can_open {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(delay));
    }
}

/// Open a native "Save As…" dialog and write an SVG file at the chosen path.
/// Returns `true` when the file was saved, `false` when the user cancelled.
///
/// Uses the `rfd` crate directly, the same way other native file dialogs are opened,
/// so the Save dialog does not depend on the dialog plugin.
#[tauri::command]
async fn save_svg_file(default_name: String, svg_content: String) -> Result<bool, String> {
    let path = rfd::FileDialog::new()
        .set_file_name(&default_name)
        .add_filter("SVG", &["svg"])
        .save_file();
    match path {
        Some(file_path) => {
            std::fs::write(&file_path, svg_content.as_bytes())
                .map_err(|e| format!("Could not save SVG: {e}"))?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Open a `.cdxml` file in the user's default application for it (ChemDraw, when installed).
/// On Windows this is `cmd /C start "" "<path>"`. Like `read_chemdraw_clipboard`, this app command
/// needs no capability entry.
#[tauri::command]
fn open_in_chemdraw(path: String) -> Result<(), String> {
    if let Some(problem) = cdxml_path_problem(&path) {
        return Err(problem);
    }

    wait_for_cdxml_unlocked(&path);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Stdio;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // `raw_arg` so the path is quoted exactly once, by us: paths with `&` or spaces stay
        // one argument for `start`. The empty "" is `start`'s window-title slot.
        std::process::Command::new("cmd")
            .args(["/C", "start", ""])
            .raw_arg(format!("\"{path}\""))
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
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

/// Talk to Ollama from the Rust process.
///
/// The installed Windows app loads the UI from `http://tauri.localhost` or
/// `https://tauri.localhost`. A browser `fetch` from that origin to
/// `http://localhost:11434` or a Tailscale address is blocked by Ollama's CORS
/// check (`OLLAMA_ORIGINS`), by WebView2 mixed-content rules, and by this app's
/// Content-Security-Policy. These commands make the same HTTP calls outside the
/// webview, so the model list and protocol parse work in the `.msi` build.
const OLLAMA_MAX_BODY: usize = 32 * 1024 * 1024;

fn ollama_client(timeout: std::time::Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("fumebook")
        .timeout(timeout)
        .connect_timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        // A machine-wide HTTP proxy must not sit between the app and a local or Tailscale Ollama.
        .no_proxy()
        .build()
        .map_err(|err| format!("Could not start the Ollama client: {err}"))
}

/// `{host_url}/{endpoint}`, with the host limited to `http` and `https`.
fn ollama_api_url(host_url: &str, endpoint: &str) -> Result<reqwest::Url, String> {
    let trimmed = host_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Enter an Ollama host URL.".into());
    }
    let mut base = reqwest::Url::parse(trimmed).map_err(|err| format!("Invalid Ollama host URL: {err}"))?;
    match base.scheme() {
        "http" | "https" => {}
        other => {
            return Err(format!(
                "Ollama host must start with http:// or https:// (got {other})."
            ));
        }
    }
    if !base.username().is_empty() || base.password().is_some() {
        return Err("The Ollama host URL cannot include a username or password.".into());
    }
    base.set_query(None);
    base.set_fragment(None);
    let joined = format!(
        "{}/{}",
        base.as_str().trim_end_matches('/'),
        endpoint.trim_start_matches('/')
    );
    reqwest::Url::parse(&joined).map_err(|err| format!("Invalid Ollama URL: {err}"))
}

fn ollama_transport_error(err: &reqwest::Error, host: &str) -> String {
    if err.is_timeout() {
        format!("Ollama at {host} did not respond in time.")
    } else if err.is_connect() {
        format!(
            "Could not connect to Ollama at {host}. Check that it is running and this computer can reach that address."
        )
    } else {
        format!("Could not reach Ollama at {host}: {err}")
    }
}

fn ollama_status_message(status: reqwest::StatusCode, body: &str) -> String {
    let trimmed = body.trim();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(message) = value.get("error").and_then(|item| item.as_str()) {
            let message = message.trim();
            if !message.is_empty() {
                return message.to_owned();
            }
        }
    }
    if trimmed.is_empty() {
        format!("Ollama replied {}.", status.as_u16())
    } else {
        let snippet: String = trimmed.chars().take(300).collect();
        format!("Ollama replied {}: {snippet}", status.as_u16())
    }
}

async fn read_ollama_response(response: reqwest::Response) -> Result<String, String> {
    let status = response.status();
    if let Some(length) = response.content_length() {
        if length > OLLAMA_MAX_BODY as u64 {
            return Err("Ollama response is too large.".into());
        }
    }
    let bytes = response.bytes().await.map_err(|err| {
        if err.is_timeout() {
            "Ollama did not finish sending a response in time.".to_owned()
        } else {
            format!("Could not read the Ollama response: {err}")
        }
    })?;
    if bytes.len() > OLLAMA_MAX_BODY {
        return Err("Ollama response is too large.".into());
    }
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|_| "Ollama returned a response that is not text.".to_string())?;
    if !status.is_success() {
        return Err(ollama_status_message(status, &text));
    }
    if text.trim().is_empty() {
        return Err("Ollama returned an empty response.".into());
    }
    Ok(text)
}

/// Optional local Python helper. A standalone Mac install usually has nothing on port 8000,
/// so any failure is a quiet `false` rather than an error the webview would log.
#[tauri::command]
async fn local_ai_health() -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(800))
        .connect_timeout(std::time::Duration::from_millis(400))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    for url in ["http://127.0.0.1:8000/health", "http://localhost:8000/health"] {
        match client.get(url).send().await {
            Ok(response) if response.status().is_success() => return true,
            _ => {}
        }
    }
    false
}

/// `GET {host_url}/api/tags`. The raw JSON is what the model dropdown parses.
#[tauri::command]
async fn ollama_list_models(host_url: String) -> Result<String, String> {
    let host = host_url.trim().trim_end_matches('/').to_owned();
    let url = ollama_api_url(&host, "api/tags")?;
    let response = ollama_client(std::time::Duration::from_secs(30))?
        .get(url)
        .send()
        .await
        .map_err(|err| ollama_transport_error(&err, &host))?;
    read_ollama_response(response).await
}

/// `POST {host_url}/api/chat`. Vision and OCR prompts can take a while, so the
/// client waits up to 180 seconds and returns the raw JSON body.
#[tauri::command]
async fn ollama_chat(host_url: String, payload: String) -> Result<String, String> {
    let host = host_url.trim().trim_end_matches('/').to_owned();
    if payload.trim().is_empty() {
        return Err("Ollama chat payload is empty.".into());
    }
    let url = ollama_api_url(&host, "api/chat")?;
    let response = ollama_client(std::time::Duration::from_secs(180))?
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|err| ollama_transport_error(&err, &host))?;
    read_ollama_response(response).await
}

#[cfg(test)]
mod ollama_tests {
    use super::{ollama_api_url, ollama_status_message};

    #[test]
    fn tags_and_chat_urls_keep_the_host() {
        assert_eq!(
            ollama_api_url("http://localhost:11434/", "api/tags").unwrap().as_str(),
            "http://localhost:11434/api/tags"
        );
        assert_eq!(
            ollama_api_url("http://100.64.1.2:11434", "api/chat").unwrap().as_str(),
            "http://100.64.1.2:11434/api/chat"
        );
        assert_eq!(
            ollama_api_url("http://[::1]:11434", "api/tags").unwrap().as_str(),
            "http://[::1]:11434/api/tags"
        );
        assert_eq!(
            ollama_api_url("http://localhost:11434/?x=1#frag", "api/tags").unwrap().as_str(),
            "http://localhost:11434/api/tags"
        );
    }

    #[test]
    fn only_http_hosts_are_accepted() {
        assert!(ollama_api_url("", "api/tags").is_err());
        assert!(ollama_api_url("file:///C:/Windows", "api/tags").is_err());
        assert!(ollama_api_url("javascript:alert(1)", "api/tags").is_err());
        assert!(ollama_api_url("http://user:pass@localhost:11434", "api/tags").is_err());
    }

    #[test]
    fn http_errors_prefer_ollamas_message() {
        let status = reqwest::StatusCode::NOT_FOUND;
        assert_eq!(
            ollama_status_message(status, r#"{"error":"model 'qwen2.5vl:7b' not found"}"#),
            "model 'qwen2.5vl:7b' not found"
        );
        assert_eq!(ollama_status_message(status, ""), "Ollama replied 404.");
    }
}

fn load_embedded_window_icon() -> Option<tauri::image::Image<'static>> {
    let bytes = include_bytes!("../icons/icon.ico");
    let img = image::load_from_memory(bytes).ok()?.into_rgba8();
    let (width, height) = img.dimensions();
    Some(tauri::image::Image::new_owned(img.into_raw(), width, height))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            use tauri::Manager;
            if let Some(icon) = load_embedded_window_icon()
                .or_else(|| app.default_window_icon().cloned())
            {
                for window in app.webview_windows().values() {
                    let _ = window.set_icon(icon.clone());
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_chemdraw_clipboard,
            read_clipboard_image_base64,
            write_structure_clipboard,
            open_in_chemdraw,
            save_svg_file,
            ollama_list_models,
            ollama_chat,
            local_ai_health
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
