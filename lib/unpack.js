'use strict'

// the PEND/UNPEND stuff tracks whether we're ready to emit end/close yet.
// but the path reservations are required to avoid race conditions where
// parallelized unpack ops may mess with one another, due to dependencies
// (like a Link depending on its target) or destructive operations (like
// clobbering an fs object to create one of a different type.)

const assert = require('assert')
const EE = require('events').EventEmitter
const Parser = require('./parse.js')
const fs = require('fs')
const fsm = require('fs-minipass')
const path = require('path')
const mkdir = require('./mkdir.js')
const mkdirSync = mkdir.sync
const wc = require('./winchars.js')
const pathReservations = require('./path-reservations.js')
const stripAbsolutePath = require('./strip-absolute-path.js')
const normPath = require('./normalize-windows-path.js')
const stripSlash = require('./strip-trailing-slashes.js')

const ONENTRY = Symbol('onEntry')
const CHECKFS = Symbol('checkFs')
const PRUNECACHE = Symbol('pruneCache')
const CHECKFS2 = Symbol('checkFs2')
const ISREUSABLE = Symbol('isReusable')
const MAKEFS = Symbol('makeFs')
const FILE = Symbol('file')
const DIRECTORY = Symbol('directory')
const LINK = Symbol('link')
const SYMLINK = Symbol('symlink')
const HARDLINK = Symbol('hardlink')
const UNSUPPORTED = Symbol('unsupported')
const UNKNOWN = Symbol('unknown')
const CHECKPATH = Symbol('checkPath')
const MKDIR = Symbol('mkdir')
const ONERROR = Symbol('onError')
const PENDING = Symbol('pending')
const PEND = Symbol('pend')
const UNPEND = Symbol('unpend')
const ENDED = Symbol('ended')
const MAYBECLOSE = Symbol('maybeClose')
const SKIP = Symbol('skip')
const DOCHOWN = Symbol('doChown')
const UID = Symbol('uid')
const GID = Symbol('gid')
const crypto = require('crypto')
const getFlag = require('./get-write-flag.js')
const platform = process.env.TESTING_TAR_FAKE_PLATFORM || process.platform
const isWindows = platform === 'win32'
const DEFAULT_MAX_DEPTH = 1024

/* istanbul ignore next */
const neverCalled = () => {
  throw new Error('sync function called cb somehow?!?')
}

// Unlinks on Windows are not atomic.
//
// This means that if you have a file entry, followed by another
// file entry with an identical name, and you cannot re-use the file
// (because it's a hardlink, or because unlink:true is set, or it's
// Windows, which does not have useful nlink values), then the unlink
// will be committed to the disk AFTER the new file has been written
// over the old one, deleting the new file.
//
// To work around this, on Windows systems, we rename the file and then
// delete the renamed file.  It's a sloppy kludge, but frankly, I do not
// know of a better way to do this, given windows' non-atomic unlink
// semantics.
//
// See: https://github.com/npm/node-tar/issues/183
/* istanbul ignore next */
const unlinkFile = (path, cb) => {
  if (!isWindows)
    return fs.unlink(path, cb)

  const name = path + '.DELETE.' + crypto.randomBytes(16).toString('hex')
  fs.rename(path, name, er => {
    if (er)
      return cb(er)
    fs.unlink(name, cb)
  })
}

/* istanbul ignore next */
const unlinkFileSync = path => {
  if (!isWindows)
    return fs.unlinkSync(path)

  const name = path + '.DELETE.' + crypto.randomBytes(16).toString('hex')
  fs.renameSync(path, name)
  fs.unlinkSync(name)
}

// clear the cache if it's a case-insensitive unicode-squashing match.
// we can't know if the current file system is case-sensitive or supports
// unicode fully, so we check for similarity on the maximally compatible
// representation.  Err on the side of pruning, since all it's doing is
// preventing lstats, and it's not the end of the world if we get a false
// positive.
// Note that on windows, we always drop the entire cache whenever a
// symbolic link is encountered, because 8.3 filenames are impossible
// to reason about, and collisions are hazards rather than just failures.
const cacheKeyNormalize = path => stripSlash(normPath(path))
  .normalize('NFKD')
  .toLowerCase()

const pruneCache = (cache, abs) => {
  abs = cacheKeyNormalize(abs)
  for (const path of cache.keys()) {
    const pnorm = cacheKeyNormalize(path)
    if (pnorm === abs || pnorm.indexOf(abs + '/') === 0)
      cache.delete(path)
  }
}

const dropCache = cache => {
  for (const key of cache.keys())
    cache.delete(key)
}

// this.gid, entry.gid, this.processUid
const uint32 = (a, b, c) =>
  a === a >>> 0 ? a
  : b === b >>> 0 ? b
  : c

class Unpack extends Parser {
  constructor (opt) {
    if (!opt)
      opt = {}

    opt.ondone = _ => {
      this[ENDED] = true
      this[MAYBECLOSE]()
    }

    super(opt)

    this.reservations = pathReservations()

    this.transform = typeof opt.transform === 'function' ? opt.transform : null

    this.writable = true
    this.readable = false

    this[PENDING] = 0
    this[ENDED] = false

    this.dirCache = opt.dirCache || new Map()

    if (typeof opt.uid === 'number' || typeof opt.gid === 'number') {
      // need both or neither
      if (typeof opt.uid !== 'number' || typeof opt.gid !== 'number')
        throw new TypeError('cannot set owner without number uid and gid')
      if (opt.preserveOwner)
        throw new TypeError(
          'cannot preserve owner in archive and also set owner explicitly')
      this.uid = opt.uid
      this.gid = opt.gid
      this.setOwner = true
    } else {
      this.uid = null
      this.gid = null
      this.setOwner = false
    }

    // default true for root
    if (opt.preserveOwner === undefined && typeof opt.uid !== 'number')
      this.preserveOwner = process.getuid && process.getuid() === 0
    else
      this.preserveOwner = !!opt.preserveOwner

    this.processUid = (this.preserveOwner || this.setOwner) && process.getuid ?
      process.getuid() : null
    this.processGid = (this.preserveOwner || this.setOwner) && process.getgid ?
      process.getgid() : null

    // prevent excessively deep nesting of subfolders
    // set to `Infinity` to remove this restriction
    this.maxDepth = typeof opt.maxDepth === 'number'
      ? opt.maxDepth
      : DEFAULT_MAX_DEPTH

    // mostly just for testing, but useful in some cases.
    // Forcibly trigger a chown on every entry, no matter what
    this.forceChown = opt.forceChown === true

    // turn ><?| in filenames into 0xf000-higher encoded forms
    this.win32 = !!opt.win32 || isWindows

    // do not unpack over files that are newer than what's in the archive
    this.newer = !!opt.newer

    // do not unpack over ANY files
    this.keep = !!opt.keep

    // do not set mtime/atime of extracted entries
    this.noMtime = !!opt.noMtime

    // allow .., absolute path entries, and unpacking through symlinks
    // without this, warn and skip .., relativize absolutes, and error
    // on symlinks in extraction path
    this.preservePaths = !!opt.preservePaths

    // unlink files and links before writing. This breaks existing hard
    // links, and removes symlink directories rather than erroring
    this.unlink = !!opt.unlink

    this.cwd = normPath(path.resolve(opt.cwd || process.cwd()))
    this.strip = +opt.strip || 0
    this.processUmask = process.umask()
    this.umask = typeof opt.umask === 'number' ? opt.umask : this.processUmask
    // default mode for dirs created as parents
    this.dmode = opt.dmode || (0o0777 & (~this.umask))
    this.fmode = opt.fmode || (0o0666 & (~this.umask))
    this.on('entry', entry => this[ONENTRY](entry))
  }

  // a bad or damaged archive is a warning for Parser, but an error
  // when extracting.  Mark those errors as unrecoverable, because
  // the Unpack contract cannot be met.
  warn (code, msg, data = {}) {
    if (code === 'TAR_BAD_ARCHIVE' || code === 'TAR_ABORT')
      data.recoverable = false
    return super.warn(code, msg, data)
  }

  [MAYBECLOSE] () {
    if (this[ENDED] && this[PENDING] === 0) {
      this.emit('prefinish')
      this.emit('finish')
      this.emit('end')
      this.emit('close')
    }
  }

  [CHECKPATH](entry) {
    const p = normPath(entry.path)
    const parts = p.split('/')

    if (this.strip) {
      if (parts.length < this.strip) {
        return false
      }
      if (entry.type === 'Link') {
        const linkparts = normPath(entry.linkpath).split('/')
        if (linkparts.length >= this.strip) {
          entry.linkpath = linkparts.slice(this.strip).join('/')
        }
      }
      parts.splice(0, this.strip)
      entry.path = parts.join('/')
    }

    if (isFinite(this.maxDepth) && parts.length > this.maxDepth) {
      this.warn('TAR_ENTRY_ERROR', 'path excessively deep', {
        entry,
        path: p,
        depth: parts.length,
        maxDepth: this.maxDepth,
      })
      return false
    }

    if (!this.preservePaths) {
      const p = normPath(entry.path)
      const parts = p.split('/')
      if (parts.includes('..') || isWindows && /^[a-z]:\.\.$/i.test(parts[0])) {
        this.warn('TAR_ENTRY_ERROR', `path contains '..'`, {
          entry,
          path: p,
        })
        return false
      }

      // absolutes on posix are also absolutes on win32
      // so we only need to test this one to get both
      const [root, stripped] = stripAbsolutePath(p)
      if (root) {
        entry.path = stripped
        this.warn('TAR_ENTRY_INFO', `stripping ${root} from absolute path`, {
          entry,
          path: p,
        })
      }
    }

    // only encode : chars that aren't drive letter indicators
    if (this.win32) {
      const parsed = path.win32.parse(entry.path)
      entry.path = parsed.root === '' ? wc.encode(entry.path)
        : parsed.root + wc.encode(entry.path.substr(parsed.root.length))
    }

    if (path.isAbsolute(entry.path))
      entry.absolute = normPath(entry.path)
    else
      entry.absolute = normPath(path.resolve(this.cwd, entry.path))
    // if we somehow ended up with a path that escapes the cwd, and we are
    // not in preservePaths mode, then something is fishy!  This should have
    // been prevented above, so ignore this for coverage.
    /* istanbul ignore if - defense in depth */
    if (!this.preservePaths &&
      entry.absolute.indexOf(this.cwd + '/') !== 0 &&
      entry.absolute !== this.cwd) {
      this.warn('TAR_ENTRY_ERROR', 'path escaped extraction target', {
        entry,
        path: normPath(entry.path),
        resolvedPath: entry.absolute,
        cwd: this.cwd,
      })
      return false
    }
    return true
  }

  [ONENTRY] (entry) {
    if (!this[CHECKPATH](entry))
      return entry.resume()

    assert.equal(typeof entry.absolute, 'string')

    switch (entry.type) {
      case 'Directory':
      case 'GNUDumpDir':
        if (entry.mode)
          entry.mode = entry.mode | 0o700

      case 'File':
      case 'OldFile':
      case 'ContiguousFile':
      case 'Link':
      case 'SymbolicLink':
        return this[CHECKFS](entry)

      case 'CharacterDevice':
      case 'BlockDevice':
      case 'FIFO':
        return this[UNSUPPORTED](entry)
    }
  }

  [ONERROR] (er, entry) {
    // Cwd has to exist, or else nothing works. That's serious.
    // Other errors are warnings, which raise the error in strict
    // mode, but otherwise continue on.
    if (er.name === 'CwdError')
      this.emit('error', er)
    else {
      this.warn('TAR_ENTRY_ERROR', er, {entry})
      this[UNPEND]()
      entry.resume()
    }
  }

  [MKDIR] (dir, mode, cb) {
    mkdir(normPath(dir), {
      uid: this.uid,
      gid: this.gid,
      processUid: this.processUid,
      processGid: this.processGid,
      umask: this.processUmask,
      preserve: this.preservePaths,
      unlink: this.unlink,
      cache: this.dirCache,
      cwd: this.cwd,
      mode: mode
    }, cb)
  }

  [DOCHOWN] (entry) {
    // in preserve owner mode, chown if the entry doesn't match process
    // in set owner mode, chown if setting doesn't match process
    return this.forceChown ||
      this.preserveOwner &&
      ( typeof entry.uid === 'number' && entry.uid !== this.processUid ||
        typeof entry.gid === 'number' && entry.gid !== this.processGid )
      ||
      ( typeof this.uid === 'number' && this.uid !== this.processUid ||
        typeof this.gid === 'number' && this.gid !== this.processGid )
  }

  [UID] (entry) {
    return uint32(this.uid, entry.uid, this.processUid)
  }

  [GID] (entry) {
    return uint32(this.gid, entry.gid, this.processGid)
  }

  [FILE] (entry, fullyDone) {
    const mode = entry.mode & 0o7777 || this.fmode
    const stream = new fsm.WriteStream(entry.absolute, {
      flags: getFlag(entry.size),
      mode: mode,
      autoClose: false
    })
    stream.on('error', er => this[ONERROR](er, entry))

    let actions = 1
    const done = er => {
      if (er)
        return this[ONERROR](er, entry)

      if (--actions === 0) {
        fs.close(stream.fd, er => {
          fullyDone()
          er ? this[ONERROR](er, entry) : this[UNPEND]()
        })
      }
    }

    stream.on('finish', _ => {
      // if futimes fails, try utimes
      // if utimes fails, fail with the original error
      // same for fchown/chown
      const abs = entry.absolute
      const fd = stream.fd

      if (entry.mtime && !this.noMtime) {
        actions++
        const atime = entry.atime || new Date()
        const mtime = entry.mtime
        fs.futimes(fd, atime, mtime, er =>
          er ? fs.utimes(abs, atime, mtime, er2 => done(er2 && er))
          : done())
      }

      if (this[DOCHOWN](entry)) {
        actions++
        const uid = this[UID](entry)
        const gid = this[GID](entry)
        fs.fchown(fd, uid, gid, er =>
          er ? fs.chown(abs, uid, gid, er2 => done(er2 && er))
          : done())
      }

      done()
    })

    const tx = this.transform ? this.transform(entry) || entry : entry
    if (tx !== entry) {
      tx.on('error', er => this[ONERROR](er, entry))
      entry.pipe(tx)
    }
    tx.pipe(stream)
  }

  [DIRECTORY] (entry, fullyDone) {
    const mode = entry.mode & 0o7777 || this.dmode
    this[MKDIR](entry.absolute, mode, er => {
      if (er) {
        fullyDone()
        return this[ONERROR](er, entry)
      }

      let actions = 1
      const done = _ => {
        if (--actions === 0) {
          fullyDone()
          this[UNPEND]()
          entry.resume()
        }
      }

      if (entry.mtime && !this.noMtime) {
        actions++
        fs.utimes(entry.absolute, entry.atime || new Date(), entry.mtime, done)
      }

      if (this[DOCHOWN](entry)) {
        actions++
        fs.chown(entry.absolute, this[UID](entry), this[GID](entry), done)
      }

      done()
    })
  }

  [UNSUPPORTED] (entry) {
    entry.unsupported = true
    this.warn('TAR_ENTRY_UNSUPPORTED',
      `unsupported entry type: ${entry.type}`, {entry})
    entry.resume()
  }

  [SYMLINK] (entry, done) {
    this[LINK](entry, entry.linkpath, 'symlink', done)
  }

  [HARDLINK] (entry, done) {
    const linkpath = normPath(path.resolve(this.cwd, entry.linkpath))
    this[LINK](entry, linkpath, 'link', done)
  }

  [PEND] () {
    this[PENDING]++
  }

  [UNPEND] () {
    this[PENDING]--
    this[MAYBECLOSE]()
  }

  [SKIP] (entry) {
    this[UNPEND]()
    entry.resume()
  }

  // Check if we can reuse an existing filesystem entry safely and
  // overwrite it, rather than unlinking and recreating
  // Windows doesn't report a useful nlink, so we just never reuse entries
  [ISREUSABLE] (entry, st) {
    return entry.type === 'File' &&
      !this.unlink &&
      st.isFile() &&
      st.nlink <= 1 &&
      !isWindows
  }

  [PRUNECACHE](entry) {
    // if we are not creating a directory, and the path is in the dirCache,
    // then that means we are about to delete the directory we created
    // previously, and it is no longer going to be a directory, and neither
    // is any of its children.
    // If a symbolic link is encountered on Windows, all bets are off.
    // There is no reasonable way to sanitize the cache in such a way
    // we will be able to avoid having filesystem collisions.  If this
    // happens with a non-symlink entry, it'll just fail to unpack,
    // but a symlink to a directory, using an 8.3 shortname, can evade
    // detection and lead to arbitrary writes to anywhere on the system.
    if (isWindows && entry.type === 'SymbolicLink')
      dropCache(this.dirCache)
    else if (entry.type !== 'Directory')
      pruneCache(this.dirCache, entry.absolute)
  }

  // check if a thing is there, and if so, try to clobber it
  [CHECKFS] (entry) {
    this[PEND]()

    // if we are not creating a directory, and the path is in the dirCache,
    // then that means we are about to delete the directory we created
    // previously, and it is no longer going to be a directory, and neither
    // is any of its children.
    this[PRUNECACHE](entry)

    const paths = [entry.path]
    if (entry.linkpath)
      paths.push(entry.linkpath)
    this.reservations.reserve(paths, done => this[CHECKFS2](entry, done))
  }
  [CHECKFS2] (entry, done) {
    this[MKDIR](path.dirname(entry.absolute), this.dmode, er => {
      if (er) {
        done()
        return this[ONERROR](er, entry)
      }
      fs.lstat(entry.absolute, (er, st) => {
        if (st && (this.keep || this.newer && st.mtime > entry.mtime)) {
          this[SKIP](entry)
          done()
        } else if (er || this[ISREUSABLE](entry, st)) {
          this[MAKEFS](null, entry, done)
        }
        else if (st.isDirectory()) {
          if (entry.type === 'Directory') {
            if (!entry.mode || (st.mode & 0o7777) === entry.mode)
              this[MAKEFS](null, entry, done)
            else
              fs.chmod(entry.absolute, entry.mode,
                er => this[MAKEFS](er, entry, done))
          } else
            fs.rmdir(entry.absolute, er => this[MAKEFS](er, entry, done))
        } else
          unlinkFile(entry.absolute, er => this[MAKEFS](er, entry, done))
      })
    })
  }

  [MAKEFS] (er, entry, done) {
    if (er)
      return this[ONERROR](er, entry)

    switch (entry.type) {
      case 'File':
      case 'OldFile':
      case 'ContiguousFile':
        return this[FILE](entry, done)

      case 'Link':
        return this[HARDLINK](entry, done)

      case 'SymbolicLink':
        return this[SYMLINK](entry, done)

      case 'Directory':
      case 'GNUDumpDir':
        return this[DIRECTORY](entry, done)
    }
  }

  [LINK] (entry, linkpath, link, done) {
    // XXX: get the type ('symlink' or 'junction') for windows
    fs[link](linkpath, entry.absolute, er => {
      if (er)
        return this[ONERROR](er, entry)
      done()
      this[UNPEND]()
      entry.resume()
    })
  }
}

class UnpackSync extends Unpack {
  constructor (opt) {
    super(opt)
  }

  [CHECKFS] (entry) {
    this[PRUNECACHE](entry)

    const er = this[MKDIR](path.dirname(entry.absolute), this.dmode, neverCalled)
    if (er)
      return this[ONERROR](er, entry)
    try {
      const st = fs.lstatSync(entry.absolute)
      if (this.keep || this.newer && st.mtime > entry.mtime)
        return this[SKIP](entry)
      else if (this[ISREUSABLE](entry, st))
        return this[MAKEFS](null, entry, neverCalled)
      else {
        try {
          if (st.isDirectory()) {
            if (entry.type === 'Directory') {
              if (entry.mode && (st.mode & 0o7777) !== entry.mode)
                fs.chmodSync(entry.absolute, entry.mode)
            } else
              fs.rmdirSync(entry.absolute)
          } else
            unlinkFileSync(entry.absolute)
          return this[MAKEFS](null, entry, neverCalled)
        } catch (er) {
          return this[ONERROR](er, entry)
        }
      }
    } catch (er) {
      return this[MAKEFS](null, entry, neverCalled)
    }
  }

  [FILE] (entry, _) {
    const mode = entry.mode & 0o7777 || this.fmode

    const oner = er => {
      let closeError
      try {
        fs.closeSync(fd)
      } catch (e) {
        closeError = e
      }
      if (er || closeError)
        this[ONERROR](er || closeError, entry)
    }

    let stream
    let fd
    try {
      fd = fs.openSync(entry.absolute, getFlag(entry.size), mode)
    } catch (er) {
      return oner(er)
    }
    const tx = this.transform ? this.transform(entry) || entry : entry
    if (tx !== entry) {
      tx.on('error', er => this[ONERROR](er, entry))
      entry.pipe(tx)
    }

    tx.on('data', chunk => {
      try {
        fs.writeSync(fd, chunk, 0, chunk.length)
      } catch (er) {
        oner(er)
      }
    })

    tx.on('end', _ => {
      let er = null
      // try both, falling futimes back to utimes
      // if either fails, handle the first error
      if (entry.mtime && !this.noMtime) {
        const atime = entry.atime || new Date()
        const mtime = entry.mtime
        try {
          fs.futimesSync(fd, atime, mtime)
        } catch (futimeser) {
          try {
            fs.utimesSync(entry.absolute, atime, mtime)
          } catch (utimeser) {
            er = futimeser
          }
        }
      }

      if (this[DOCHOWN](entry)) {
        const uid = this[UID](entry)
        const gid = this[GID](entry)

        try {
          fs.fchownSync(fd, uid, gid)
        } catch (fchowner) {
          try {
            fs.chownSync(entry.absolute, uid, gid)
          } catch (chowner) {
            er = er || fchowner
          }
        }
      }

      oner(er)
    })
  }

  [DIRECTORY] (entry, _) {
    const mode = entry.mode & 0o7777 || this.dmode
    const er = this[MKDIR](entry.absolute, mode)
    if (er)
      return this[ONERROR](er, entry)
    if (entry.mtime && !this.noMtime) {
      try {
        fs.utimesSync(entry.absolute, entry.atime || new Date(), entry.mtime)
      } catch (er) {}
    }
    if (this[DOCHOWN](entry)) {
      try {
        fs.chownSync(entry.absolute, this[UID](entry), this[GID](entry))
      } catch (er) {}
    }
    entry.resume()
  }

  [MKDIR] (dir, mode) {
    try {
      return mkdir.sync(normPath(dir), {
        uid: this.uid,
        gid: this.gid,
        processUid: this.processUid,
        processGid: this.processGid,
        umask: this.processUmask,
        preserve: this.preservePaths,
        unlink: this.unlink,
        cache: this.dirCache,
        cwd: this.cwd,
        mode: mode
      })
    } catch (er) {
      return er
    }
  }

  [LINK] (entry, linkpath, link, _) {
    try {
      fs[link + 'Sync'](linkpath, entry.absolute)
      entry.resume()
    } catch (er) {
      return this[ONERROR](er, entry)
    }
  }
}

Unpack.Sync = UnpackSync
module.exports = Unpack
