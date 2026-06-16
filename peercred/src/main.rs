//! peercred — SO_PEERCRED helper for launcherd
//!
//! A tiny server that wraps a unix socket and returns the caller's UID.
//! launcherd spawns this as a sidecar; in-box clients connect through it.
//!
//! Protocol (NDJSON, same as launcherd):
//!   Client sends: {"method":"spawn",...}
//!   Server prepends caller info and forwards to launcherd:
//!     {"method":"spawn","_caller":{"uid":1000,"gid":1000,"pid":12345},...}
//!   Response is passed back unchanged.
//!
//! Usage:
//!   peercred --frontend /run/launcherd.sock --backend /tmp/launcherd.sock
//!
//! The frontend is what boxes connect to; the backend is the real launcherd.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::io::AsRawFd;
use std::env;
use std::fs;
use std::thread;

/// Get peer credentials from a unix socket fd using SO_PEERCRED
fn get_peer_cred(fd: i32) -> Option<(u32, u32, i32)> {
    // ucred struct: pid (i32), uid (u32), gid (u32)
    #[repr(C)]
    struct UCred {
        pid: i32,
        uid: u32,
        gid: u32,
    }

    let mut cred = UCred { pid: 0, uid: 0, gid: 0 };
    let mut len = std::mem::size_of::<UCred>() as u32;

    // SO_PEERCRED = 17 on Linux
    const SO_PEERCRED: i32 = 17;
    const SOL_SOCKET: i32 = 1;

    // getsockopt lives in libc, which Rust links by default — declare it directly
    // rather than depend on the `libc` crate, keeping this binary dependency-free.
    extern "C" {
        fn getsockopt(
            sockfd: i32,
            level: i32,
            optname: i32,
            optval: *mut core::ffi::c_void,
            optlen: *mut u32,
        ) -> i32;
    }

    let ret = unsafe {
        getsockopt(
            fd,
            SOL_SOCKET,
            SO_PEERCRED,
            &mut cred as *mut UCred as *mut core::ffi::c_void,
            &mut len as *mut u32,
        )
    };

    if ret == 0 {
        Some((cred.uid, cred.gid, cred.pid))
    } else {
        None
    }
}

fn handle_client(mut client: UnixStream, backend_path: &str) {
    let fd = client.as_raw_fd();
    let cred = get_peer_cred(fd);

    // Connect to backend
    let mut backend = match UnixStream::connect(backend_path) {
        Ok(s) => s,
        Err(e) => {
            let _ = writeln!(client, r#"{{"id":"","ok":false,"error":{{"code":"BACKEND_ERROR","message":"{}"}}}}"#, e);
            return;
        }
    };

    let client_clone = match client.try_clone() {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut reader = BufReader::new(client_clone);

    // Read one line from client
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }

    // Parse JSON and inject _caller
    let injected = if let Some((uid, gid, pid)) = cred {
        // Simple JSON injection: find first { and insert after it
        if let Some(pos) = line.find('{') {
            let caller_json = format!(r#""_caller":{{"uid":{},"gid":{},"pid":{}}},"#, uid, gid, pid);
            let mut modified = line[..pos+1].to_string();
            modified.push_str(&caller_json);
            modified.push_str(&line[pos+1..]);
            modified
        } else {
            line
        }
    } else {
        line
    };

    // Forward to backend
    if backend.write_all(injected.as_bytes()).is_err() {
        return;
    }

    // Read response and forward back
    let mut backend_reader = BufReader::new(backend);
    let mut response = String::new();
    if backend_reader.read_line(&mut response).is_ok() {
        let _ = client.write_all(response.as_bytes());
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();

    let mut frontend_path = "/run/launcherd.sock".to_string();
    let mut backend_path = "/tmp/launcherd-backend.sock".to_string();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--frontend" | "-f" => {
                i += 1;
                if i < args.len() {
                    frontend_path = args[i].clone();
                }
            }
            "--backend" | "-b" => {
                i += 1;
                if i < args.len() {
                    backend_path = args[i].clone();
                }
            }
            "-h" | "--help" => {
                println!("peercred — SO_PEERCRED injector for launcherd");
                println!();
                println!("Usage: peercred [OPTIONS]");
                println!();
                println!("Options:");
                println!("  -f, --frontend PATH  Socket path for clients (default: /run/launcherd.sock)");
                println!("  -b, --backend PATH   Socket path for launcherd (default: /tmp/launcherd-backend.sock)");
                println!("  -h, --help           Show this help");
                return;
            }
            _ => {}
        }
        i += 1;
    }

    // Remove existing socket
    let _ = fs::remove_file(&frontend_path);

    let listener = match UnixListener::bind(&frontend_path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("peercred: failed to bind {}: {}", frontend_path, e);
            std::process::exit(1);
        }
    };

    eprintln!("peercred: listening on {} → {}", frontend_path, backend_path);

    for stream in listener.incoming() {
        match stream {
            Ok(client) => {
                let backend = backend_path.clone();
                thread::spawn(move || {
                    handle_client(client, &backend);
                });
            }
            Err(e) => {
                eprintln!("peercred: accept error: {}", e);
            }
        }
    }
}
