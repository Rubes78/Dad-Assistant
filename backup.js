/**
 * backup.js — config file backup before changes
 *
 * Copies config files to a standardized backup directory on the host
 * before Tier 2 commands that modify state. Preserves full original paths.
 *
 * Backup location: /opt/fatharr-backups/{timestamp}/{full/original/path}
 *
 * Safety guardrails:
 *   - Single file > 1 GB → prompt for approval
 *   - Aggregate > 10 GB → prompt for approval
 *   - Insufficient disk space → refuse
 *   - Media file extensions → skip automatically
 */

const BACKUP_DIR = process.env.BACKUP_DIR || '/opt/fatharr-backups';
const MAX_SINGLE_FILE = 1 * 1024 * 1024 * 1024;   // 1 GB
const MAX_AGGREGATE   = 10 * 1024 * 1024 * 1024;  // 10 GB
const RETENTION_DAYS  = 7;

const MEDIA_EXTENSIONS = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|iso|img|bin|nfo|srt|sub|ass|idx|ssa)$/i;

// Common config file paths associated with docker compose commands
const COMPOSE_CONFIG_PATTERNS = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  '.env',
];

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Attempt to back up relevant files before a Tier 2 command.
 * @param {string} command — the command about to be executed
 * @param {Function} runSsh — function to run SSH commands (from tools.js)
 * @returns {Object} — { success, backup_path } or { error } or { needs_confirmation, message }
 */
async function backupBeforeChange(command, runSsh) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const backupBase = `${BACKUP_DIR}/${timestamp}`;

  // Determine which files to back up based on the command
  const filesToBackup = await identifyFiles(command, runSsh);
  if (!filesToBackup.length) {
    return { success: true, message: 'No config files identified for backup.' };
  }

  // Filter out media files
  const filtered = filesToBackup.filter(f => {
    if (MEDIA_EXTENSIONS.test(f.path)) {
      console.log(`Backup: skipping media file ${f.path}`);
      return false;
    }
    return true;
  });

  if (!filtered.length) {
    return { success: true, message: 'All identified files were media files — skipped.' };
  }

  // Check individual file sizes
  for (const file of filtered) {
    if (file.size > MAX_SINGLE_FILE) {
      return {
        needs_confirmation: true,
        message: `File ${file.path} is ${formatSize(file.size)} (over 1 GB). Approve backup?`,
      };
    }
  }

  // Check aggregate size
  const totalSize = filtered.reduce((sum, f) => sum + f.size, 0);
  if (totalSize > MAX_AGGREGATE) {
    return {
      needs_confirmation: true,
      message: `Total backup size is ${formatSize(totalSize)} (over 10 GB limit). Approve?`,
    };
  }

  // Check available disk space
  try {
    const spaceResult = await runSsh(`df -B1 --output=avail ${BACKUP_DIR} 2>/dev/null | tail -1 || df -B1 --output=avail / | tail -1`);
    const available = parseInt(spaceResult.stdout?.trim(), 10);
    if (!isNaN(available) && available < totalSize * 2) {
      return { error: `Not enough disk space for backup. Need ${formatSize(totalSize)}, have ${formatSize(available)}.` };
    }
  } catch {
    // If we can't check disk space, proceed with caution
    console.warn('Backup: could not check available disk space');
  }

  // Perform backups
  try {
    await runSsh(`mkdir -p ${backupBase}`);
    for (const file of filtered) {
      const destPath = `${backupBase}${file.path}`;
      await runSsh(`mkdir -p "$(dirname '${destPath}')" && cp -p '${file.path}' '${destPath}'`);
    }
    console.log(`Backup created: ${backupBase} (${filtered.length} files, ${formatSize(totalSize)})`);
    return { success: true, backup_path: backupBase, files: filtered.length, size: formatSize(totalSize) };
  } catch (err) {
    return { error: `Backup failed: ${err.message}` };
  }
}

/**
 * Identify config files relevant to a command.
 */
async function identifyFiles(command, runSsh) {
  const files = [];

  // Docker compose commands — find compose files in the working directory
  if (/docker\s+compose/.test(command)) {
    try {
      // Try to find compose files
      for (const name of COMPOSE_CONFIG_PATTERNS) {
        const result = await runSsh(`find / -maxdepth 4 -name '${name}' -not -path '*/node_modules/*' -not -path '*/proc/*' 2>/dev/null | head -5`);
        if (result.stdout) {
          for (const filePath of result.stdout.split('\n').filter(Boolean)) {
            const sizeResult = await runSsh(`stat -c%s '${filePath}' 2>/dev/null`);
            const size = parseInt(sizeResult.stdout?.trim(), 10) || 0;
            files.push({ path: filePath, size });
          }
        }
      }
    } catch {}
  }

  // Systemctl commands — back up the unit file if identifiable
  const systemctlMatch = command.match(/systemctl\s+(?:restart|stop|disable)\s+(\S+)/);
  if (systemctlMatch) {
    const unit = systemctlMatch[1];
    try {
      const result = await runSsh(`systemctl show -p FragmentPath ${unit} 2>/dev/null | cut -d= -f2`);
      if (result.stdout?.trim()) {
        const filePath = result.stdout.trim();
        const sizeResult = await runSsh(`stat -c%s '${filePath}' 2>/dev/null`);
        const size = parseInt(sizeResult.stdout?.trim(), 10) || 0;
        files.push({ path: filePath, size });
      }
    } catch {}
  }

  return files;
}

/**
 * Clean up backups older than RETENTION_DAYS.
 * @param {Function} runSsh — function to run SSH commands
 */
async function cleanupOldBackups(runSsh) {
  try {
    const result = await runSsh(`find ${BACKUP_DIR} -maxdepth 1 -type d -mtime +${RETENTION_DAYS} 2>/dev/null`);
    if (!result.stdout?.trim()) return { cleaned: 0 };

    const dirs = result.stdout.trim().split('\n').filter(d => d !== BACKUP_DIR);
    if (!dirs.length) return { cleaned: 0 };

    for (const dir of dirs) {
      await runSsh(`rm -rf '${dir}'`);
    }
    console.log(`Backup cleanup: removed ${dirs.length} old backups`);
    return { cleaned: dirs.length };
  } catch (err) {
    console.warn('Backup cleanup failed:', err.message);
    return { error: err.message };
  }
}

module.exports = { backupBeforeChange, cleanupOldBackups, formatSize };
