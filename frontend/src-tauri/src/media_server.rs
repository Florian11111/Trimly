//! Kleiner HTTP-Server auf 127.0.0.1, über den die Oberfläche Videos abspielt.
//!
//! Tauris Asset-Protokoll beantwortet Range-Anfragen mit höchstens 1 MB. Bei
//! langen Videos ist allein der Index (`moov`) größer, dann zeigt WebKit kein
//! Bild. Dieser Server streamt beliebige Ranges direkt aus der Datei.
//!
//! Sicherheit: nur Loopback, zufälliges Token in jeder URL, und es werden nur
//! Dateien ausgeliefert, die vorher mit `register` freigegeben wurden.

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::fs::File;
use std::hash::{BuildHasher, Hasher};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub struct MediaServer {
    port: u16,
    token: String,
    files: Arc<Mutex<HashMap<String, PathBuf>>>,
    next_id: Mutex<u64>,
}

fn random_hex() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    (0..2)
        .map(|i| {
            let mut h = RandomState::new().build_hasher();
            h.write_u128(nanos);
            h.write_u32(std::process::id());
            h.write_u8(i);
            format!("{:016x}", h.finish())
        })
        .collect()
}

impl MediaServer {
    pub fn start() -> io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        let token = random_hex();
        let files: Arc<Mutex<HashMap<String, PathBuf>>> = Arc::default();

        let (t, f) = (token.clone(), files.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (t, f) = (t.clone(), f.clone());
                std::thread::spawn(move || {
                    let _ = handle(stream, &t, &f);
                });
            }
        });

        Ok(Self { port, token, files, next_id: Mutex::new(0) })
    }

    /// Gibt eine Datei frei und liefert die URL, unter der sie abspielbar ist.
    pub fn register(&self, path: &Path) -> String {
        let mut next = self.next_id.lock().unwrap();
        *next += 1;
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("mp4").to_lowercase();
        let name = format!("{}.{}", *next, ext);
        self.files.lock().unwrap().insert(name.clone(), path.to_path_buf());
        format!("http://127.0.0.1:{}/{}/{}", self.port, self.token, name)
    }
}

/// Auswertung eines `Range`-Headers für eine Datei der Länge `len`.
/// `None` = ganze Datei, `Some(Err)` = nicht erfüllbar, sonst inklusive Grenzen.
pub fn parse_range(header: Option<&str>, len: u64) -> Option<Result<(u64, u64), ()>> {
    let spec = header?.trim().strip_prefix("bytes=")?;
    // Mehrteilige Ranges braucht kein Player; nur die erste beachten
    let first = spec.split(',').next()?.trim();
    let (a, b) = first.split_once('-')?;
    let range = match (a.trim(), b.trim()) {
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            if n == 0 || len == 0 {
                return Some(Err(()));
            }
            (len.saturating_sub(n), len - 1)
        }
        (s, "") => (s.parse().ok()?, len.saturating_sub(1)),
        (s, e) => {
            let (s, e): (u64, u64) = (s.parse().ok()?, e.parse().ok()?);
            if e < s {
                return Some(Err(()));
            }
            (s, e.min(len.saturating_sub(1)))
        }
    };
    if range.0 >= len {
        Some(Err(()))
    } else {
        Some(Ok(range))
    }
}

fn content_type(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("") {
        "mov" => "video/quicktime",
        "m4v" => "video/x-m4v",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        _ => "video/mp4",
    }
}

fn handle(stream: TcpStream, token: &str, files: &Mutex<HashMap<String, PathBuf>>) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut out = stream;

    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut range_header = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range_header = Some(v.trim().to_string());
            }
        }
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    let file = target
        .strip_prefix('/')
        .and_then(|p| p.split_once('/'))
        .filter(|(t, _)| *t == token)
        .and_then(|(_, name)| files.lock().unwrap().get(name).cloned().map(|p| (name.to_string(), p)));

    let Some((name, path)) = file.filter(|_| method == "GET" || method == "HEAD") else {
        return out.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    };

    let mut f = File::open(&path)?;
    let len = f.metadata()?.len();
    let head = format!(
        "Content-Type: {}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: close\r\n",
        content_type(&name)
    );

    let (status, start, end) = match parse_range(range_header.as_deref(), len) {
        None => ("200 OK", 0, len.saturating_sub(1)),
        Some(Ok((s, e))) => ("206 Partial Content", s, e),
        Some(Err(())) => {
            let msg = format!(
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\n{head}\r\n"
            );
            return out.write_all(msg.as_bytes());
        }
    };
    let count = if len == 0 { 0 } else { end - start + 1 };

    let mut header = format!("HTTP/1.1 {status}\r\nContent-Length: {count}\r\n{head}");
    if status.starts_with("206") {
        header += &format!("Content-Range: bytes {start}-{end}/{len}\r\n");
    }
    header += "\r\n";
    out.write_all(header.as_bytes())?;

    if method == "GET" && count > 0 {
        f.seek(SeekFrom::Start(start))?;
        // Bricht der Player ab (Sprung im Video), endet copy mit einem Fehler – normal
        let _ = io::copy(&mut f.take(count), &mut out);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ranges() {
        assert_eq!(parse_range(None, 100), None);
        assert_eq!(parse_range(Some("bytes=0-1"), 100), Some(Ok((0, 1))));
        assert_eq!(parse_range(Some("bytes=10-"), 100), Some(Ok((10, 99))));
        assert_eq!(parse_range(Some("bytes=-10"), 100), Some(Ok((90, 99))));
        assert_eq!(parse_range(Some("bytes=50-5000"), 100), Some(Ok((50, 99))));
        assert_eq!(parse_range(Some("bytes=0-9, 20-29"), 100), Some(Ok((0, 9))));
        assert_eq!(parse_range(Some("bytes=100-"), 100), Some(Err(())));
        assert_eq!(parse_range(Some("bytes=9-3"), 100), Some(Err(())));
        assert_eq!(parse_range(Some("items=0-1"), 100), None);
    }

    fn get(url: &str, range: Option<&str>) -> (String, Vec<u8>) {
        let rest = url.strip_prefix("http://").unwrap();
        let (host, path) = rest.split_once('/').unwrap();
        let mut s = TcpStream::connect(host).unwrap();
        let mut req = format!("GET /{path} HTTP/1.1\r\nHost: {host}\r\n");
        if let Some(r) = range {
            req += &format!("Range: {r}\r\n");
        }
        req += "\r\n";
        s.write_all(req.as_bytes()).unwrap();
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).unwrap();
        let split = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        (String::from_utf8_lossy(&buf[..split]).to_string(), buf[split + 4..].to_vec())
    }

    #[test]
    fn serves_registered_files_with_large_ranges() {
        let data: Vec<u8> = (0..5_000_000u32).map(|i| (i % 251) as u8).collect();
        let path = std::env::temp_dir().join(format!("trimly_media_{}.mp4", std::process::id()));
        std::fs::write(&path, &data).unwrap();

        let server = MediaServer::start().unwrap();
        let url = server.register(&path);

        // Größer als die 1 MB, an denen das Asset-Protokoll scheitert
        let (head, body) = get(&url, Some("bytes=100-4100099"));
        assert!(head.starts_with("HTTP/1.1 206"), "{head}");
        assert!(head.contains("Content-Range: bytes 100-4100099/5000000"));
        assert_eq!(body.len(), 4_100_000);
        assert_eq!(&body[..], &data[100..4_100_100]);

        let (head, body) = get(&url, None);
        assert!(head.starts_with("HTTP/1.1 200"));
        assert_eq!(body.len(), data.len());

        let (head, _) = get(&url, Some("bytes=6000000-"));
        assert!(head.starts_with("HTTP/1.1 416"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn refuses_wrong_token_and_unregistered_files() {
        let server = MediaServer::start().unwrap();
        let url = server.register(Path::new("/etc/hosts"));
        let wrong_token = url.replace(&server.token, "falsch");
        assert!(get(&wrong_token, None).0.starts_with("HTTP/1.1 404"));
        let unregistered = url.replace("/1.", "/2.");
        assert!(get(&unregistered, None).0.starts_with("HTTP/1.1 404"));
    }
}
