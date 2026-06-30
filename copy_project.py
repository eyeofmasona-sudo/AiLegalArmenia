import os
import shutil
import re

SOURCE_DIR = r"d:\1V\ailegalarmenia-main"
DEST_DIR = r"d:\1V\NEW_REPO_FOLDER_NAME"

EXCLUDE_DIRS = {
    '.git', 'node_modules', 'dist', 'build', '.next', '.turbo', '.cache', 
    'coverage', '__pycache__', '.venv', 'venv'
}

EXCLUDE_FILES_REGEX = [
    re.compile(r'^\.env(\..*)?$'),
    re.compile(r'^\.DS_Store$'),
    re.compile(r'^copy_project\.py$'),
    re.compile(r'.*\.log$'),
    re.compile(r'^Thumbs\.db$')
]

SKIP_SECRET_SCAN_REGEX = [
    re.compile(r'.*\.lock$'),
    re.compile(r'^package-lock\.json$'),
    re.compile(r'.*\.svg$'),
    re.compile(r'.*\.txt$'),
    re.compile(r'^skills-lock\.json$')
]

SECRET_REGEX = [
    r'(?i)api[_-]?key\s*[:=]\s*["\']?[a-zA-Z0-9_\-]{20,}["\']?',
    r'(?i)secret\s*[:=]\s*["\']?[a-zA-Z0-9_\-]{20,}["\']?',
    r'(?i)token\s*[:=]\s*["\']?[a-zA-Z0-9_\-]{20,}["\']?',
    r'(?i)password\s*[:=]\s*["\']?[a-zA-Z0-9_\-]{8,}["\']?',
    r'-----BEGIN (?:RSA )?PRIVATE KEY-----'
]

security_findings = []
copied_files = []
excluded_items = []

if os.path.exists(DEST_DIR):
    shutil.rmtree(DEST_DIR)
os.makedirs(DEST_DIR)

for root, dirs, files in os.walk(SOURCE_DIR):
    original_dirs = list(dirs)
    dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
    
    for d in original_dirs:
        if d in EXCLUDE_DIRS:
            rel = os.path.relpath(os.path.join(root, d), SOURCE_DIR)
            excluded_items.append(rel + "/")
            
    rel_path = os.path.relpath(root, SOURCE_DIR)
    dest_path = os.path.join(DEST_DIR, rel_path) if rel_path != '.' else DEST_DIR
    
    if not os.path.exists(dest_path):
        os.makedirs(dest_path)
        
    for f in files:
        if any(regex.match(f) for regex in EXCLUDE_FILES_REGEX):
            excluded_items.append(os.path.join(rel_path, f))
            continue
            
        src_file = os.path.join(root, f)
        dest_file = os.path.join(dest_path, f)
        
        if not any(regex.match(f) for regex in SKIP_SECRET_SCAN_REGEX):
            try:
                is_secret = False
                with open(src_file, 'r', encoding='utf-8') as f_in:
                    content = f_in.read()
                    for pattern in SECRET_REGEX:
                        matches = re.findall(pattern, content)
                        if matches:
                            is_secret = True
                            security_findings.append(f"{os.path.join(rel_path, f)} contains potential secret")
                            break
                if is_secret:
                    excluded_items.append(os.path.join(rel_path, f) + " (Secret found)")
                    continue
            except UnicodeDecodeError:
                pass
            
        shutil.copy2(src_file, dest_file)
        copied_files.append(os.path.join(rel_path, f))

# Write updated .gitignore
gitignore_content = """# Dependencies
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
"""
with open(os.path.join(DEST_DIR, '.gitignore'), 'w', encoding='utf-8') as f:
    f.write(gitignore_content)

with open(r'd:\1V\copy_log.txt', 'w', encoding='utf-8') as log_out:
    log_out.write("Security findings:\n" + "\n".join(security_findings) + "\n\n")
    log_out.write("Excluded items:\n" + "\n".join(excluded_items) + "\n\n")
    log_out.write("Copied files count: " + str(len(copied_files)))
