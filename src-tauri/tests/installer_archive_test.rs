use std::fs::{self, File};
use std::io::Write;
use std::ops::Deref;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use zorvo_lib::installer::archive::{
    ensure_agent_command, format_for_url, unpack, ArchiveFormat, UnpackError, UnpackLimits,
};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A fresh, empty dir unique to one test, removed when dropped.
struct TempDir(PathBuf);

impl Deref for TempDir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn temp_dir() -> TempDir {
    let dir = std::env::temp_dir().join(format!(
        "zorvo-archive-test-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    TempDir(dir)
}

/// One archive member, written verbatim (paths are not checked by these builders).
enum Entry {
    File(&'static str, &'static [u8], u32),
    Dir(&'static str),
    Symlink(&'static str, &'static str),
    /// Tar only.
    HardLink(&'static str, &'static str),
    /// Tar only.
    Fifo(&'static str),
}

fn tar_header(kind: tar::EntryType, name: &str, link: &str, size: u64, mode: u32) -> tar::Header {
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(kind);
    header.set_size(size);
    header.set_mode(mode);
    // Raw bytes, because `set_path` refuses the hostile names these tests need.
    let old = header.as_old_mut();
    old.name[..name.len()].copy_from_slice(name.as_bytes());
    old.linkname[..link.len()].copy_from_slice(link.as_bytes());
    header.set_cksum();
    header
}

fn write_tar<W: Write>(out: W, entries: &[Entry]) -> W {
    let mut builder = tar::Builder::new(out);
    for entry in entries {
        let (header, data): (tar::Header, &[u8]) = match entry {
            Entry::File(name, data, mode) => (
                tar_header(tar::EntryType::Regular, name, "", data.len() as u64, *mode),
                data,
            ),
            Entry::Dir(name) => (
                tar_header(tar::EntryType::Directory, name, "", 0, 0o755),
                &[],
            ),
            Entry::Symlink(name, target) => (
                tar_header(tar::EntryType::Symlink, name, target, 0, 0o777),
                &[],
            ),
            Entry::HardLink(name, target) => (
                tar_header(tar::EntryType::Link, name, target, 0, 0o644),
                &[],
            ),
            Entry::Fifo(name) => (tar_header(tar::EntryType::Fifo, name, "", 0, 0o644), &[]),
        };
        builder.append(&header, data).unwrap();
    }
    builder.into_inner().unwrap()
}

fn write_zip(out: File, entries: &[Entry]) {
    let mut zip = zip::ZipWriter::new(out);
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for entry in entries {
        match entry {
            Entry::File(name, data, mode) => {
                zip.start_file(*name, stored.unix_permissions(*mode))
                    .unwrap();
                zip.write_all(data).unwrap();
            }
            Entry::Dir(name) => zip.add_directory(*name, stored).unwrap(),
            Entry::Symlink(name, target) => zip.add_symlink(*name, *target, stored).unwrap(),
            Entry::HardLink(..) | Entry::Fifo(_) => panic!("zip has no such entry"),
        }
    }
    zip.finish().unwrap();
}

/// Writes `entries` as an archive of `format` inside `dir` and returns its path.
fn build(dir: &Path, format: ArchiveFormat, entries: &[Entry]) -> PathBuf {
    let path = dir.join("archive");
    let file = File::create(&path).unwrap();
    match format {
        ArchiveFormat::TarGz => {
            let gz = write_tar(
                flate2::write::GzEncoder::new(file, flate2::Compression::fast()),
                entries,
            );
            gz.finish().unwrap();
        }
        ArchiveFormat::TarBz2 => {
            let bz = write_tar(
                bzip2::write::BzEncoder::new(file, bzip2::Compression::fast()),
                entries,
            );
            bz.finish().unwrap();
        }
        ArchiveFormat::Zip => write_zip(file, entries),
    }
    path
}

fn roomy() -> UnpackLimits {
    UnpackLimits {
        max_total_bytes: 1 << 20,
        max_entries: 100,
    }
}

/// Builds `entries` and unpacks them into `<tmp>/out`, returning the result and that dir.
fn unpack_entries(
    tmp: &Path,
    format: ArchiveFormat,
    entries: &[Entry],
    limits: &UnpackLimits,
) -> (Result<(), UnpackError>, PathBuf) {
    let archive = build(tmp, format, entries);
    let dest = tmp.join("out");
    fs::create_dir_all(&dest).unwrap();
    let result = unpack(&archive, format, &dest, limits, &AtomicBool::new(false));
    (result, dest)
}

fn mode(path: &Path) -> u32 {
    fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777
}

fn assert_unsafe(result: Result<(), UnpackError>) {
    assert!(
        matches!(result, Err(UnpackError::UnsafeEntry(_))),
        "expected UnsafeEntry, got {result:?}"
    );
}

macro_rules! format_tests {
    ($module:ident, $format:expr) => {
        mod $module {
            use super::*;

            #[test]
            fn unpacks_files_dirs_and_exec_bits() {
                let tmp = temp_dir();
                let (result, dest) = unpack_entries(
                    &tmp,
                    $format,
                    &[
                        Entry::Dir("pkg/"),
                        Entry::File("pkg/README", b"hello", 0o644),
                        Entry::File("pkg/bin/tool", b"#!/bin/sh\n", 0o755),
                        Entry::File("./other/deep/file.txt", b"x", 0o600),
                        Entry::Dir("empty/"),
                    ],
                    &roomy(),
                );
                result.unwrap();
                assert_eq!(fs::read(dest.join("pkg/README")).unwrap(), b"hello");
                assert_eq!(mode(&dest.join("pkg/README")), 0o644);
                assert_eq!(mode(&dest.join("pkg/bin/tool")), 0o755);
                assert_eq!(fs::read(dest.join("other/deep/file.txt")).unwrap(), b"x");
                assert_eq!(mode(&dest.join("other/deep/file.txt")), 0o600);
                assert!(dest.join("empty").is_dir());
            }

            #[test]
            fn keeps_a_symlink_that_stays_inside() {
                let tmp = temp_dir();
                let (result, dest) = unpack_entries(
                    &tmp,
                    $format,
                    &[
                        // The link comes before its target, as in Node's tarball.
                        Entry::Symlink("bin/npx", "../lib/npx-cli.js"),
                        Entry::File("lib/npx-cli.js", b"npx", 0o755),
                        Entry::Symlink("Versions/Current", "A"),
                        Entry::Dir("Versions/A/"),
                    ],
                    &roomy(),
                );
                result.unwrap();
                let link = dest.join("bin/npx");
                assert!(fs::symlink_metadata(&link)
                    .unwrap()
                    .file_type()
                    .is_symlink());
                assert_eq!(
                    fs::read_link(&link).unwrap(),
                    PathBuf::from("../lib/npx-cli.js")
                );
                assert_eq!(fs::read(&link).unwrap(), b"npx");
                assert!(dest.join("Versions/Current").is_dir());
            }

            #[test]
            fn rejects_an_absolute_path() {
                let tmp = temp_dir();
                let (result, _) = unpack_entries(
                    &tmp,
                    $format,
                    &[Entry::File("/tmp/zorvo-evil", b"x", 0o644)],
                    &roomy(),
                );
                assert_unsafe(result);
                assert!(!Path::new("/tmp/zorvo-evil").exists());
            }

            #[test]
            fn rejects_a_parent_dir_component() {
                let tmp = temp_dir();
                let (result, _) = unpack_entries(
                    &tmp,
                    $format,
                    &[Entry::File("pkg/../../evil", b"x", 0o644)],
                    &roomy(),
                );
                assert_unsafe(result);
                assert!(!tmp.join("evil").exists());
            }

            #[test]
            fn rejects_a_symlink_leaving_the_destination() {
                let tmp = temp_dir();
                let (result, dest) =
                    unpack_entries(&tmp, $format, &[Entry::Symlink("a", "../../etc")], &roomy());
                assert_unsafe(result);
                assert!(fs::symlink_metadata(dest.join("a")).is_err());
            }

            #[test]
            fn rejects_an_absolute_symlink() {
                let tmp = temp_dir();
                let (result, _) =
                    unpack_entries(&tmp, $format, &[Entry::Symlink("a", "/etc")], &roomy());
                assert_unsafe(result);
            }

            #[test]
            fn rejects_a_symlink_that_climbs_out_through_another_link() {
                // `deep/x/up` resolves to the destination, so `deep/escape` (via
                // `x/up/..`) is the destination's parent, though it reads as `deep/x`.
                let tmp = temp_dir();
                let (result, _) = unpack_entries(
                    &tmp,
                    $format,
                    &[
                        Entry::Symlink("deep/x/up", "../.."),
                        Entry::Symlink("deep/escape", "x/up/.."),
                    ],
                    &roomy(),
                );
                assert_unsafe(result);
            }

            #[test]
            fn rejects_an_entry_written_through_a_symlink() {
                let tmp = temp_dir();
                let (result, dest) = unpack_entries(
                    &tmp,
                    $format,
                    &[
                        Entry::Dir("real/"),
                        Entry::Symlink("link", "real"),
                        Entry::File("link/file", b"x", 0o644),
                    ],
                    &roomy(),
                );
                assert_unsafe(result);
                assert!(!dest.join("real/file").exists());
            }

            #[test]
            fn stops_at_the_entry_cap() {
                let tmp = temp_dir();
                let limits = UnpackLimits {
                    max_total_bytes: 1 << 20,
                    max_entries: 3,
                };
                let (result, dest) = unpack_entries(
                    &tmp,
                    $format,
                    &[
                        Entry::File("a", b"a", 0o644),
                        Entry::File("b", b"b", 0o644),
                        Entry::File("c", b"c", 0o644),
                        Entry::File("d", b"d", 0o644),
                    ],
                    &limits,
                );
                assert_eq!(result, Err(UnpackError::TooManyEntries));
                assert!(!dest.join("d").exists());
            }

            #[test]
            fn stops_at_the_size_cap() {
                let tmp = temp_dir();
                let limits = UnpackLimits {
                    max_total_bytes: 10,
                    max_entries: 100,
                };
                let (result, dest) = unpack_entries(
                    &tmp,
                    $format,
                    &[
                        Entry::File("a", b"123456", 0o644),
                        Entry::File("b", b"123456", 0o644),
                    ],
                    &limits,
                );
                assert_eq!(result, Err(UnpackError::TooLarge));
                assert!(!dest.join("b").exists());
            }

            #[test]
            fn stops_when_cancelled() {
                let tmp = temp_dir();
                let archive = build(&tmp, $format, &[Entry::File("a", b"a", 0o644)]);
                let dest = tmp.join("out");
                let result = unpack(&archive, $format, &dest, &roomy(), &AtomicBool::new(true));
                assert_eq!(result, Err(UnpackError::Cancelled));
                assert!(!dest.join("a").exists());
            }
        }
    };
}

format_tests!(tar_gz, ArchiveFormat::TarGz);
format_tests!(tar_bz2, ArchiveFormat::TarBz2);
format_tests!(zip_archive, ArchiveFormat::Zip);

#[test]
fn rejects_a_hard_link() {
    let tmp = temp_dir();
    let (result, dest) = unpack_entries(
        &tmp,
        ArchiveFormat::TarGz,
        &[
            Entry::File("a.txt", b"a", 0o644),
            Entry::HardLink("b.txt", "a.txt"),
        ],
        &roomy(),
    );
    assert_unsafe(result);
    assert!(!dest.join("b.txt").exists());
}

#[test]
fn unpacks_a_gnu_long_name() {
    let tmp = temp_dir();
    let long = format!("pkg/{}/file.txt", "d".repeat(150));
    let archive = tmp.join("archive");
    let mut builder = tar::Builder::new(File::create(&archive).unwrap());
    let mut header = tar::Header::new_gnu();
    header.set_size(2);
    header.set_mode(0o644);
    builder.append_data(&mut header, &long, &b"ok"[..]).unwrap();
    builder.into_inner().unwrap();
    let gz = tmp.join("archive.tar.gz");
    let mut encoder =
        flate2::write::GzEncoder::new(File::create(&gz).unwrap(), flate2::Compression::fast());
    std::io::copy(&mut File::open(&archive).unwrap(), &mut encoder).unwrap();
    encoder.finish().unwrap();
    let dest = tmp.join("out");

    unpack(
        &gz,
        ArchiveFormat::TarGz,
        &dest,
        &roomy(),
        &AtomicBool::new(false),
    )
    .unwrap();

    assert_eq!(fs::read(dest.join(&long)).unwrap(), b"ok");
}

#[test]
fn rejects_a_fifo() {
    let tmp = temp_dir();
    let (result, dest) =
        unpack_entries(&tmp, ArchiveFormat::TarGz, &[Entry::Fifo("pipe")], &roomy());
    assert_unsafe(result);
    assert!(fs::symlink_metadata(dest.join("pipe")).is_err());
}

#[test]
fn drops_a_setuid_bit() {
    let tmp = temp_dir();
    let (result, dest) = unpack_entries(
        &tmp,
        ArchiveFormat::TarGz,
        &[Entry::File("tool", b"x", 0o4755)],
        &roomy(),
    );
    result.unwrap();
    assert_eq!(
        fs::metadata(dest.join("tool"))
            .unwrap()
            .permissions()
            .mode()
            & 0o7777,
        0o755
    );
}

#[test]
fn unsafe_entry_message_names_the_agent_and_path() {
    let err = UnpackError::UnsafeEntry("../evil".to_string());
    assert_eq!(
        err.user_message("Cursor"),
        "Cursor's archive contains a file Zorvo will not unpack: ../evil"
    );
    for other in [
        UnpackError::TooLarge,
        UnpackError::TooManyEntries,
        UnpackError::Cancelled,
        UnpackError::DiskFull,
        UnpackError::Io("disk".to_string()),
    ] {
        assert!(other.user_message("Cursor").contains("Cursor"), "{other:?}");
    }
}

#[test]
fn production_limits_match_the_spec() {
    let limits = UnpackLimits::production();
    assert_eq!(limits.max_total_bytes, 4 << 30);
    assert_eq!(limits.max_entries, 200_000);
}

#[test]
fn format_for_url_reads_the_ending() {
    assert_eq!(
        format_for_url("https://example.com/coco-1.0.73%2B180523.e6179a031de9-darwin-arm64.tar.gz"),
        Some(ArchiveFormat::TarGz)
    );
    assert_eq!(
        format_for_url("https://example.com/x.tgz?sig=1"),
        Some(ArchiveFormat::TarGz)
    );
    assert_eq!(
        format_for_url("https://example.com/x.tar.bz2#frag"),
        Some(ArchiveFormat::TarBz2)
    );
    assert_eq!(
        format_for_url("https://example.com/x.zip"),
        Some(ArchiveFormat::Zip)
    );
    assert_eq!(format_for_url("https://example.com/x.tar.xz"), None);
    assert_eq!(format_for_url("https://example.com/zip?x=.tar.gz"), None);
}

#[test]
fn ensure_agent_command_sets_the_exec_bit_on_cmd_only() {
    let tmp = temp_dir();
    fs::write(tmp.join("agent"), b"bin").unwrap();
    fs::write(tmp.join("data.txt"), b"data").unwrap();
    fs::set_permissions(tmp.join("agent"), fs::Permissions::from_mode(0o644)).unwrap();
    fs::set_permissions(tmp.join("data.txt"), fs::Permissions::from_mode(0o644)).unwrap();

    let path = ensure_agent_command(&tmp, "agent").unwrap();

    assert_eq!(path, tmp.join("agent"));
    assert_eq!(mode(&tmp.join("agent")), 0o755);
    assert_eq!(mode(&tmp.join("data.txt")), 0o644);
}

#[test]
fn ensure_agent_command_keeps_an_existing_exec_bit() {
    let tmp = temp_dir();
    fs::write(tmp.join("agent"), b"bin").unwrap();
    fs::set_permissions(tmp.join("agent"), fs::Permissions::from_mode(0o700)).unwrap();

    ensure_agent_command(&tmp, "agent").unwrap();

    assert_eq!(mode(&tmp.join("agent")), 0o700);
}

#[test]
fn ensure_agent_command_finds_a_nested_cmd() {
    let tmp = temp_dir();
    let (result, dest) = unpack_entries(
        &tmp,
        ArchiveFormat::TarGz,
        &[Entry::File(
            "./dist-package/cursor-agent",
            b"#!/bin/sh\n",
            0o644,
        )],
        &roomy(),
    );
    result.unwrap();

    let path = ensure_agent_command(&dest, "./dist-package/cursor-agent").unwrap();

    assert_eq!(path, dest.join("dist-package/cursor-agent"));
    assert!(path.is_absolute());
    assert_eq!(mode(&path), 0o755);
}

#[test]
fn ensure_agent_command_rejects_a_missing_cmd() {
    let tmp = temp_dir();
    fs::create_dir_all(tmp.join("bin")).unwrap();
    assert_eq!(
        ensure_agent_command(&tmp, "bin/agent"),
        Err("bin/agent is not in the archive".to_string())
    );
    assert_eq!(
        ensure_agent_command(&tmp, "bin"),
        Err("bin is not in the archive".to_string())
    );
    assert_eq!(
        ensure_agent_command(&tmp, "../agent"),
        Err("../agent is not in the archive".to_string())
    );
}

#[test]
fn ensure_agent_command_rejects_a_symlink_out() {
    let tmp = temp_dir();
    let outside = temp_dir();
    fs::write(outside.join("real"), b"bin").unwrap();
    fs::set_permissions(outside.join("real"), fs::Permissions::from_mode(0o644)).unwrap();
    symlink(outside.join("real"), tmp.join("agent")).unwrap();

    assert_eq!(
        ensure_agent_command(&tmp, "agent"),
        Err("agent is not in the archive".to_string())
    );
    assert_eq!(mode(&outside.join("real")), 0o644);
}

#[test]
fn ensure_agent_command_follows_a_symlink_inside() {
    let tmp = temp_dir();
    fs::create_dir_all(tmp.join("bin")).unwrap();
    fs::create_dir_all(tmp.join("lib")).unwrap();
    fs::write(tmp.join("lib/cli.js"), b"js").unwrap();
    fs::set_permissions(tmp.join("lib/cli.js"), fs::Permissions::from_mode(0o644)).unwrap();
    symlink("../lib/cli.js", tmp.join("bin/agent")).unwrap();

    let path = ensure_agent_command(&tmp, "bin/agent").unwrap();

    assert_eq!(path, tmp.join("bin/agent"));
    assert_eq!(mode(&tmp.join("lib/cli.js")), 0o755);
}
