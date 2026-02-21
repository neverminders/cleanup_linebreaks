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

function detectTextEncoding(bytes) {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { encoding: 'utf-16le', bom: new Uint8Array([0xff, 0xfe]) };
    }

    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return { encoding: 'utf-16be', bom: new Uint8Array([0xfe, 0xff]) };
    }
  }

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', bom: new Uint8Array([0xef, 0xbb, 0xbf]) };
  }

  let evenNulls = 0;
  let oddNulls = 0;
  const limit = Math.min(bytes.length, 4096);
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] !== 0x00) {
      continue;
    }

    if (i % 2 === 0) {
      evenNulls += 1;
    } else {
      oddNulls += 1;
    }
  }

  if (oddNulls > evenNulls * 2 && oddNulls > 8) {
    return { encoding: 'utf-16le', bom: null };
  }

  if (evenNulls > oddNulls * 2 && evenNulls > 8) {
    return { encoding: 'utf-16be', bom: null };
  }

  return { encoding: 'utf-8', bom: null };
}

function decodeText(bytes, encodingInfo) {
  const offset = encodingInfo.bom?.length || 0;
  const payload = bytes.slice(offset);
  const decoder = new TextDecoder(encodingInfo.encoding);
  return decoder.decode(payload);
}

function encodeUtf16(text, littleEndian) {
  const out = new Uint8Array(text.length * 2);

  for (let i = 0; i < text.length; i += 1) {
    const codeUnit = text.charCodeAt(i);
    const low = codeUnit & 0xff;
    const high = (codeUnit >>> 8) & 0xff;
    const index = i * 2;

    if (littleEndian) {
      out[index] = low;
      out[index + 1] = high;
    } else {
      out[index] = high;
      out[index + 1] = low;
    }
  }

  return out;
}

function encodeText(text, encodingInfo) {
  let encoded;
  if (encodingInfo.encoding === 'utf-16le') {
    encoded = encodeUtf16(text, true);
  } else if (encodingInfo.encoding === 'utf-16be') {
    encoded = encodeUtf16(text, false);
  } else {
    encoded = new TextEncoder().encode(text);
  }

  if (!encodingInfo.bom) {
    return encoded;
  }

  const merged = new Uint8Array(encodingInfo.bom.length + encoded.length);
  merged.set(encodingInfo.bom, 0);
  merged.set(encoded, encodingInfo.bom.length);
  return merged;
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

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function downloadModifiedFiles(modifiedFiles) {
  for (const file of modifiedFiles) {
    const blob = new Blob([file.contentBytes], { type: file.type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();

    await wait(120);

    a.remove();
    URL.revokeObjectURL(url);
  }
}

async function processFiles() {
  const includeMarkers = includeMarkersCheckbox.checked;
  const modified = [];

  for (const [relativePath, file] of selectedFiles.entries()) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const encodingInfo = detectTextEncoding(bytes);
    const text = decodeText(bytes, encodingInfo);
    const cleaned = normalizeLineBreaks(text, includeMarkers);

    if (cleaned === text) {
      continue;
    }

    const originalName = relativePath.split('/').pop() || file.name;
    const versionedName = nextVersionedName(originalName);

    modified.push({
      path: relativePath,
      name: versionedName,
      contentBytes: encodeText(cleaned, encodingInfo),
      type: file.type || 'text/plain;charset=utf-8',
    });
  }

  if (modified.length === 0) {
    summary.textContent = 'Nu există modificări de salvat (după regulile selectate).';
    return;
  }

  await downloadModifiedFiles(modified);

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
