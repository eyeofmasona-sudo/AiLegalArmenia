import fs from 'fs';
import path from 'path';

const SOURCE_DIR = 'd:\\1V\\ailegalarmenia-main';
const DEST_DIR = 'd:\\1V\\NEW_REPO_FOLDER_NAME';

const EXCLUDE_DIRS = new Set([
    '.git', 'node_modules', 'dist', 'build', '.next', '.turbo', '.cache', 
    'coverage', '__pycache__', '.venv', 'venv'
]);

const EXCLUDE_FILES_REGEX = [
    /^\.env(\..*)?$/,
    /^\.DS_Store$/,
    /^copy_project\.(py|mjs)$/,
    /.*\.log$/,
    /^Thumbs\.db$/
];

const SKIP_SECRET_SCAN_REGEX = [
    /.*\.lock$/,
    /^package-lock\.json$/,
    /.*\.svg$/,
    /.*\.txt$/,
    /^skills-lock\.json$/,
    /.*\.png$/,
    /.*\.jpg$/,
    /.*\.woff2?$/
];

const SECRET_REGEX = [
    /api[_-]?key\s*[:=]\s*["']?[a-zA-Z0-9_\-]{20,}["']?/i,
    /secret\s*[:=]\s*["']?[a-zA-Z0-9_\-]{20,}["']?/i,
    /token\s*[:=]\s*["']?[a-zA-Z0-9_\-]{20,}["']?/i,
    /password\s*[:=]\s*["']?[a-zA-Z0-9_\-]{8,}["']?/i,
    /-----BEGIN (RSA )?PRIVATE KEY-----/
];

const security_findings = [];
const copied_files = [];
const excluded_items = [];

if (fs.existsSync(DEST_DIR)) {
    fs.rmSync(DEST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DEST_DIR, { recursive: true });

function walkSync(currentDirPath) {
    const items = fs.readdirSync(currentDirPath, { withFileTypes: true });
    for (const item of items) {
        const fullPath = path.join(currentDirPath, item.name);
        const relPath = path.relative(SOURCE_DIR, fullPath);
        
        if (item.isDirectory()) {
            if (EXCLUDE_DIRS.has(item.name)) {
                excluded_items.push(relPath + '\\');
                continue;
            }
            fs.mkdirSync(path.join(DEST_DIR, relPath), { recursive: true });
            walkSync(fullPath);
        } else {
            if (EXCLUDE_FILES_REGEX.some(regex => regex.test(item.name))) {
                excluded_items.push(relPath);
                continue;
            }
            
            const destPath = path.join(DEST_DIR, relPath);
            let skip_copy = false;
            
            if (!SKIP_SECRET_SCAN_REGEX.some(regex => regex.test(item.name))) {
                try {
                    const content = fs.readFileSync(fullPath, 'utf-8');
                    for (const pattern of SECRET_REGEX) {
                        if (pattern.test(content)) {
                            security_findings.push(`${relPath} contains potential secret`);
                            skip_copy = true;
                            break;
                        }
                    }
                } catch (e) {
                    // Ignore read errors, mostly for binary files
                }
            }
            
            if (skip_copy) {
                excluded_items.push(`${relPath} (Secret found)`);
                continue;
            }
            
            fs.copyFileSync(fullPath, destPath);
            copied_files.push(relPath);
        }
    }
}

walkSync(SOURCE_DIR);

const gitignoreContent = `# Dependencies
node_modules/
.venv/
venv/
__pycache__/

# Builds
dist/
build/
.next/
.turbo/
out/

# Caches
.cache/
coverage/
.eslintcache

# Environment
.env
.env.*

# Logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# System
.DS_Store
Thumbs.db
`;

fs.writeFileSync(path.join(DEST_DIR, '.gitignore'), gitignoreContent, 'utf-8');

fs.writeFileSync('d:\\1V\\copy_log.txt', 
    "Security findings:\n" + security_findings.join("\n") + "\n\n" +
    "Excluded items:\n" + excluded_items.join("\n") + "\n\n" +
    "Copied files count: " + copied_files.length
);
