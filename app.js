const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const includeMarkersCheckbox = document.getElementById('include-markers');
const processBtn = document.getElementById('process-btn');
const summary = document.getElementById('summary');
const details = document.getElementById('details');

/** @type {Map<string, File>} */
const selectedFiles = new Map();
const ACCEPTED_EXTENSIONS = new Set(['csv', 'tsv']);
const LINE_BREAK_PATTERN = /\r\n|\n\r|\r|\n|\u000b|\u000c|\u0085|\u2028|\u2029/g;
const XLSX_ESCAPED_BREAKS_PATTERN = /_x000D_|_x000A_/gi;

function isCsvOrTsv(name) {
  const extension = name.split('.').pop()?.toLowerCase();
  return Boolean(extension && ACCEPTED_EXTENSIONS.has(extension));
}

function nextVersionedName(name) {
  const dotIndex = name.lastIndexOf('.');
  const base = dotIndex >= 0 ? name.slice(0, dotIndex) : name;
  const extension = dotIndex >= 0 ? name.slice(dotIndex) : '';

  const versionMatch = base.match(/^(.*)-v(\d+)$/i);
  if (!versionMatch) {
    return `${base}-v1${extension}`;
  }

  const nextVersion = Number.parseInt(versionMatch[2], 10) + 1;
  return `${versionMatch[1]}-v${nextVersion}${extension}`;
}

function normalizeLineBreaks(content, includeMarkers) {
  let normalized = content
    .replace(XLSX_ESCAPED_BREAKS_PATTERN, '\r')
    .replace(LINE_BREAK_PATTERN, '\r');

  if (includeMarkers) {
    normalized = normalized.replace(/\s\|\|\s/g, '\r');
  }

  return normalized;
}

function updateSelectionSummary() {
  const total = selectedFiles.size;
  if (total === 0) {
    summary.textContent = 'Niciun fișier CSV/TSV selectat.';
    processBtn.disabled = true;
    details.innerHTML = '';
    return;
  }

  summary.textContent = `${total} fișier(e) CSV/TSV pregătit(e) pentru procesare.`;
  processBtn.disabled = false;

  details.innerHTML = '';
  for (const path of selectedFiles.keys()) {
    const li = document.createElement('li');
    li.textContent = path;
    details.appendChild(li);
  }
}

function addFiles(fileList) {
  for (const file of fileList) {
    if (!isCsvOrTsv(file.name)) {
      continue;
    }

    const relativePath = file.webkitRelativePath || file.name;
    selectedFiles.set(relativePath, file);
  }

  updateSelectionSummary();
}

async function walkEntry(entry, parentPath = '') {
  if (!entry) {
    return;
  }

  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    const fullPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;

    if (isCsvOrTsv(file.name)) {
      const wrappedFile = new File([file], file.name, { type: file.type, lastModified: file.lastModified });
      Object.defineProperty(wrappedFile, 'webkitRelativePath', {
        value: fullPath,
        configurable: true,
      });
      selectedFiles.set(fullPath, wrappedFile);
    }

    return;
  }

  if (entry.isDirectory) {
    const reader = entry.createReader();
    const readEntries = () =>
      new Promise((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });

    let entries = await readEntries();
    while (entries.length > 0) {
      for (const child of entries) {
        await walkEntry(child, parentPath ? `${parentPath}/${entry.name}` : entry.name);
      }
      entries = await readEntries();
    }
  }
}

async function handleDrop(event) {
  event.preventDefault();
  dropZone.classList.remove('drag-over');

  const items = [...(event.dataTransfer?.items || [])];
  if (items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
    for (const item of items) {
      const entry = item.webkitGetAsEntry();
      await walkEntry(entry);
    }
    updateSelectionSummary();
    return;
  }

  addFiles(event.dataTransfer?.files || []);
}

async function processFiles() {
  const includeMarkers = includeMarkersCheckbox.checked;
  const modified = [];

  for (const [relativePath, file] of selectedFiles.entries()) {
    const text = await file.text();
    const cleaned = normalizeLineBreaks(text, includeMarkers);

    if (cleaned === text) {
      continue;
    }

    const originalName = relativePath.split('/').pop() || file.name;
    const versionedName = nextVersionedName(originalName);

    modified.push({
      path: relativePath,
      name: versionedName,
      content: cleaned,
      type: file.type || 'text/plain;charset=utf-8',
    });
  }

  if (modified.length === 0) {
    summary.textContent = 'Nu există modificări de salvat (după regulile selectate).';
    return;
  }

  for (const file of modified) {
    const blob = new Blob([file.content], { type: file.type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  summary.textContent = `${modified.length} fișier(e) modificate descărcate.`;
  details.innerHTML = '';
  for (const file of modified) {
    const li = document.createElement('li');
    li.textContent = `${file.path} → ${file.name}`;
    details.appendChild(li);
  }
}

fileInput.addEventListener('change', (event) => {
  addFiles(event.target.files || []);
});

dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (event) => {
  handleDrop(event).catch((error) => {
    console.error(error);
    summary.textContent = 'A apărut o eroare la încărcarea fișierelor.';
  });
});

processBtn.addEventListener('click', () => {
  processFiles().catch((error) => {
    console.error(error);
    summary.textContent = 'A apărut o eroare la procesare.';
  });
});
