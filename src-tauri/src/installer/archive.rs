//! Unpacks a downloaded archive (Node.js, uv, binary agents) entry by entry.
//!
//! The SHA-256 pin proves the archive is the one Zorvo expects, not that its
//! entries are safe, so every entry is checked here before anything is
//! written: no absolute paths or `..`, no symlink that resolves outside the
//! destination, no hard links, devices or FIFOs, nothing written through a
//! symlink, and caps on the entry count and the unpacked size.

use std::collections::HashSet;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, Read};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const GIB: u64 = 1 << 30;
const PERMISSION_BITS: u32 = 0o777;
const EXEC_BITS: u32 = 0o111;
/// Directories stay usable by their owner, so later entries and cleanup can write in them.
const OWNER_RWX: u32 = 0o700;
const DEFAULT_FILE_MODE: u32 = 0o644;
const DEFAULT_DIR_MODE: u32 = 0o755;
/// A zip symlink stores its target as content; anything longer is not a real path.
const MAX_LINK_TARGET_BYTES: u64 = 4096;
const S_IFMT: u32 = 0o170000;
const S_IFREG: u32 = 0o100000;
const S_IFDIR: u32 = 0o040000;
const S_IFLNK: u32 = 0o120000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    TarGz,
    TarBz2,
    Zip,
}

/// The format named by the URL's path ending, ignoring any query or fragment.
pub fn format_for_url(url: &str) -> Option<ArchiveFormat> {
    let end = url.find(['?', '#']).unwrap_or(url.len());
    let path = url[..end].to_ascii_lowercase();
    if path.ends_with(".tar.gz") || path.ends_with(".tgz") {
        Some(ArchiveFormat::TarGz)
    } else if path.ends_with(".tar.bz2") {
        Some(ArchiveFormat::TarBz2)
    } else if path.ends_with(".zip") {
        Some(ArchiveFormat::Zip)
    } else {
        None
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnpackLimits {
    pub max_total_bytes: u64,
    pub max_entries: u64,
}

impl UnpackLimits {
    pub fn production() -> Self {
        Self {
            max_total_bytes: 4 * GIB,
            max_entries: 200_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnpackError {
    /// The entry's path (or `link -> target`) as written in the archive.
    UnsafeEntry(String),
    TooLarge,
    TooManyEntries,
    Cancelled,
    DiskFull,
    Io(String),
}

impl UnpackError {
    /// The message shown to the user; `name` is the agent or runtime being installed.
    pub fn user_message(&self, name: &str) -> String {
        match self {
            Self::UnsafeEntry(path) => {
                format!("{name}'s archive contains a file Zorvo will not unpack: {path}")
            }
            Self::TooLarge => format!("{name}'s archive is too large to unpack"),
            Self::TooManyEntries => format!("{name}'s archive has too many files to unpack"),
            Self::Cancelled => format!("Unpacking {name} was cancelled"),
            Self::DiskFull => format!("Not enough disk space to install {name}"),
            Self::Io(reason) => format!("Could not unpack {name} ({reason})"),
        }
    }
}

/// Keeps a full disk distinct, so the user is told to free space rather than shown an OS error.
fn io_error(err: io::Error) -> UnpackError {
    if err.kind() == io::ErrorKind::StorageFull {
        UnpackError::DiskFull
    } else {
        UnpackError::Io(err.to_string())
    }
}

/// Unwraps the zip crate's I/O errors, whose own message is only "i/o error".
fn zip_error(err: zip::result::ZipError) -> UnpackError {
    match err {
        zip::result::ZipError::Io(err) => io_error(err),
        other => UnpackError::Io(other.to_string()),
    }
}

fn unsafe_entry(path: &Path) -> UnpackError {
    // A file entry named `./` has no path left once `.` is dropped.
    let shown = if path.as_os_str().is_empty() {
        Path::new(".")
    } else {
        path
    };
    UnpackError::UnsafeEntry(shown.display().to_string())
}

/// Unpacks `archive` into `dest` (created if missing). On error, whatever was
/// already written stays in `dest`; the caller deletes its staging dir.
pub fn unpack(
    archive: &Path,
    format: ArchiveFormat,
    dest: &Path,
    limits: &UnpackLimits,
    cancel: &AtomicBool,
) -> Result<(), UnpackError> {
    let mut unpacker = Unpacker {
        dest,
        limits,
        cancel,
        entries: 0,
        bytes: 0,
        real_dirs: HashSet::new(),
    };
    unpacker.check_cancel()?;
    fs::create_dir_all(dest).map_err(io_error)?;
    let file = BufReader::new(File::open(archive).map_err(io_error)?);
    match format {
        ArchiveFormat::TarGz => unpack_tar(flate2::read::MultiGzDecoder::new(file), &mut unpacker),
        ArchiveFormat::TarBz2 => unpack_tar(bzip2::read::MultiBzDecoder::new(file), &mut unpacker),
        ArchiveFormat::Zip => unpack_zip(file, &mut unpacker),
    }
}

fn unpack_tar(reader: impl Read, unpacker: &mut Unpacker) -> Result<(), UnpackError> {
    use tar::EntryType;

    let mut archive = tar::Archive::new(reader);
    for entry in archive.entries().map_err(io_error)? {
        let mut entry = entry.map_err(io_error)?;
        unpacker.begin_entry()?;
        let kind = entry.header().entry_type();
        if kind == EntryType::XGlobalHeader {
            continue;
        }
        let raw = entry.path().map_err(io_error)?.into_owned();
        let rel = safe_relative_path(&raw)?;
        let mode = entry.header().mode().map_err(io_error)?;
        match kind {
            EntryType::Regular | EntryType::Continuous => {
                let size = entry.size();
                unpacker.write_file(&rel, &mut entry, size, mode)?;
            }
            EntryType::Directory => unpacker.make_dir(&rel, mode)?,
            EntryType::Symlink => {
                let target = entry
                    .link_name()
                    .map_err(io_error)?
                    .ok_or_else(|| unsafe_entry(&raw))?
                    .into_owned();
                unpacker.make_symlink(&rel, &target)?;
            }
            // Hard links, devices, FIFOs, sparse files and anything unknown.
            _ => return Err(unsafe_entry(&raw)),
        }
    }
    Ok(())
}

fn unpack_zip(reader: BufReader<File>, unpacker: &mut Unpacker) -> Result<(), UnpackError> {
    let mut archive = zip::ZipArchive::new(reader).map_err(zip_error)?;
    // The central directory states the count up front, so fail before writing anything.
    if archive.len() as u64 > unpacker.limits.max_entries {
        return Err(UnpackError::TooManyEntries);
    }
    for index in 0..archive.len() {
        unpacker.begin_entry()?;
        let mut entry = archive.by_index(index).map_err(zip_error)?;
        let raw = PathBuf::from(entry.name());
        let rel = safe_relative_path(&raw)?;
        let unix_mode = entry.unix_mode();
        let file_type = unix_mode.map_or(0, |mode| mode & S_IFMT);
        let permissions = unix_mode.map(|mode| mode & PERMISSION_BITS);
        if entry.is_dir() || file_type == S_IFDIR {
            unpacker.make_dir(&rel, permissions.unwrap_or(DEFAULT_DIR_MODE))?;
        } else if file_type == S_IFLNK {
            let target = read_zip_link_target(&mut entry, &raw)?;
            unpacker.make_symlink(&rel, &target)?;
        } else if file_type == 0 || file_type == S_IFREG {
            let size = entry.size();
            let mode = permissions.unwrap_or(DEFAULT_FILE_MODE);
            unpacker.write_file(&rel, &mut entry, size, mode)?;
        } else {
            return Err(unsafe_entry(&raw));
        }
    }
    Ok(())
}

fn read_zip_link_target(entry: &mut impl Read, raw: &Path) -> Result<PathBuf, UnpackError> {
    let mut bytes = Vec::new();
    entry
        .take(MAX_LINK_TARGET_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > MAX_LINK_TARGET_BYTES {
        return Err(unsafe_entry(raw));
    }
    Ok(PathBuf::from(OsString::from_vec(bytes)))
}

/// The entry's path made relative to the destination, or `UnsafeEntry` when
/// any component is absolute, a drive prefix, `..` or contains a NUL byte.
/// `.` components are dropped, so `./dist-package/x` is `dist-package/x`.
fn safe_relative_path(raw: &Path) -> Result<PathBuf, UnpackError> {
    let mut rel = PathBuf::new();
    for component in raw.components() {
        match component {
            Component::Normal(part) if !part.as_bytes().contains(&0) => rel.push(part),
            Component::CurDir => {}
            _ => return Err(unsafe_entry(raw)),
        }
    }
    Ok(rel)
}

/// Accepts a link target only as `..`s followed by plain names, staying under
/// the destination when resolved from the link's own directory.
///
/// A `..` after a name is refused even when it reads as inside: that name may
/// itself be a symlink, so `up/..` can resolve above where it appears to.
/// With the shape enforced, every symlink resolves inside the destination,
/// whatever links it passes through and whether or not its target exists yet.
fn check_link_target(link: &Path, target: &Path) -> Result<(), UnpackError> {
    let refuse = || UnpackError::UnsafeEntry(format!("{} -> {}", link.display(), target.display()));
    if target.as_os_str().is_empty() {
        return Err(refuse());
    }
    let mut depth = link
        .parent()
        .map_or(0, |parent| parent.components().count());
    let mut seen_name = false;
    for component in target.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir if !seen_name && depth > 0 => depth -= 1,
            Component::Normal(part) if !part.as_bytes().contains(&0) => seen_name = true,
            _ => return Err(refuse()),
        }
    }
    Ok(())
}

struct Unpacker<'a> {
    dest: &'a Path,
    limits: &'a UnpackLimits,
    cancel: &'a AtomicBool,
    entries: u64,
    bytes: u64,
    /// Relative paths already checked to be real directories. Unpacking never
    /// removes a directory, so they stay real.
    real_dirs: HashSet<PathBuf>,
}

impl Unpacker<'_> {
    fn check_cancel(&self) -> Result<(), UnpackError> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(UnpackError::Cancelled);
        }
        Ok(())
    }

    fn begin_entry(&mut self) -> Result<(), UnpackError> {
        self.check_cancel()?;
        self.entries += 1;
        if self.entries > self.limits.max_entries {
            return Err(UnpackError::TooManyEntries);
        }
        Ok(())
    }

    fn write_file(
        &mut self,
        rel: &Path,
        reader: &mut impl Read,
        declared_size: u64,
        mode: u32,
    ) -> Result<(), UnpackError> {
        if rel.as_os_str().is_empty() {
            return Err(unsafe_entry(rel));
        }
        let remaining = self.limits.max_total_bytes.saturating_sub(self.bytes);
        if declared_size > remaining {
            return Err(UnpackError::TooLarge);
        }
        let path = self.prepare_parent(rel)?;
        remove_non_dir(&path)?;
        // `create_new` refuses to follow a symlink planted at the path.
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(io_error)?;
        // A zip header can understate the size, so the copy itself is capped too.
        let copied =
            io::copy(&mut reader.take(remaining.saturating_add(1)), &mut file).map_err(io_error)?;
        if copied > remaining {
            return Err(UnpackError::TooLarge);
        }
        self.bytes += copied;
        file.set_permissions(fs::Permissions::from_mode(mode & PERMISSION_BITS))
            .map_err(io_error)
    }

    fn make_dir(&mut self, rel: &Path, mode: u32) -> Result<(), UnpackError> {
        if rel.as_os_str().is_empty() {
            return Ok(());
        }
        let path = self.prepare_parent(rel)?;
        self.ensure_real_dir(rel, &path, rel)?;
        let permissions = fs::Permissions::from_mode((mode & PERMISSION_BITS) | OWNER_RWX);
        fs::set_permissions(&path, permissions).map_err(io_error)
    }

    fn make_symlink(&mut self, rel: &Path, target: &Path) -> Result<(), UnpackError> {
        if rel.as_os_str().is_empty() {
            return Err(unsafe_entry(rel));
        }
        check_link_target(rel, target)?;
        let path = self.prepare_parent(rel)?;
        remove_non_dir(&path)?;
        std::os::unix::fs::symlink(target, &path).map_err(io_error)
    }

    /// Creates the entry's missing parent directories and returns its full path.
    /// Refuses an entry whose parent passes through a symlink, so nothing is
    /// ever written outside the destination by way of a link.
    fn prepare_parent(&mut self, rel: &Path) -> Result<PathBuf, UnpackError> {
        let mut prefix = PathBuf::new();
        for component in rel.parent().into_iter().flat_map(Path::components) {
            prefix.push(component);
            let path = self.dest.join(&prefix);
            self.ensure_real_dir(&prefix, &path, rel)?;
        }
        Ok(self.dest.join(rel))
    }

    /// Makes sure `path` (relative `prefix`) is a real directory, creating it
    /// when missing; a symlink there makes `entry` unsafe.
    fn ensure_real_dir(
        &mut self,
        prefix: &Path,
        path: &Path,
        entry: &Path,
    ) -> Result<(), UnpackError> {
        if self.real_dirs.contains(prefix) {
            return Ok(());
        }
        match fs::symlink_metadata(path) {
            Ok(meta) if meta.is_dir() => {}
            Ok(meta) if meta.file_type().is_symlink() => return Err(unsafe_entry(entry)),
            Ok(_) => {
                return Err(UnpackError::Io(format!(
                    "{} is not a folder",
                    prefix.display()
                )))
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(path).map_err(io_error)?
            }
            Err(err) => return Err(io_error(err)),
        }
        self.real_dirs.insert(prefix.to_path_buf());
        Ok(())
    }
}

/// Removes a file or symlink an earlier entry left at `path`, so a duplicate
/// entry replaces it rather than writing through it. Directories are kept.
fn remove_non_dir(path: &Path) -> Result<(), UnpackError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.is_dir() => fs::remove_file(path).map_err(io_error),
        _ => Ok(()),
    }
}

/// Finds the agent's `cmd` (relative to `dest`, a leading `./` allowed) and
/// makes it executable when no exec bit is set; only `cmd` is touched.
/// Returns the absolute path to launch.
pub fn ensure_agent_command(dest: &Path, cmd: &str) -> Result<PathBuf, String> {
    let missing = || format!("{cmd} is not in the archive");
    let rel = safe_relative_path(Path::new(cmd)).map_err(|_| missing())?;
    if rel.as_os_str().is_empty() {
        return Err(missing());
    }
    let path = std::path::absolute(dest.join(&rel)).map_err(|_| missing())?;
    // `cmd` may be a symlink inside the tree (like Node's `bin/npx`), but what it
    // resolves to must be a regular file inside `dest`.
    let real = path.canonicalize().map_err(|_| missing())?;
    let real_dest = dest.canonicalize().map_err(|_| missing())?;
    let meta = fs::metadata(&real).map_err(|_| missing())?;
    if !real.starts_with(&real_dest) || !meta.is_file() {
        return Err(missing());
    }
    let mode = meta.permissions().mode();
    if mode & EXEC_BITS == 0 {
        fs::set_permissions(&real, fs::Permissions::from_mode(mode | EXEC_BITS))
            .map_err(|err| format!("Could not make {cmd} executable ({err})"))?;
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn storage_full() -> io::Error {
        io::Error::new(io::ErrorKind::StorageFull, "No space left on device")
    }

    #[test]
    fn a_full_disk_maps_to_disk_full() {
        assert_eq!(io_error(storage_full()), UnpackError::DiskFull);
        assert_eq!(
            zip_error(zip::result::ZipError::Io(storage_full())),
            UnpackError::DiskFull
        );
        assert_eq!(
            UnpackError::DiskFull.user_message("Cursor"),
            "Not enough disk space to install Cursor"
        );
    }

    #[test]
    fn other_io_errors_keep_their_reason() {
        let denied = io::Error::new(io::ErrorKind::PermissionDenied, "denied");
        assert_eq!(io_error(denied), UnpackError::Io("denied".to_string()));
        let wrapped = zip::result::ZipError::Io(io::Error::other("bad read"));
        assert_eq!(zip_error(wrapped), UnpackError::Io("bad read".to_string()));
    }
}
