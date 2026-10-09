const waitingScreen = document.querySelector('#waiting-screen');
const taskScreen = document.querySelector('#task-screen');
const participantInput = document.querySelector('#participant-id');
const startButton = document.querySelector('#start-button');
const taskCancel = document.querySelector('#task-cancel');
const resultCancel = document.querySelector('#result-cancel');
const actionButton = document.querySelector('#action-button');
const input = document.querySelector('#transcription-input');
const coloredOutput = document.querySelector('#colored-output');
const promptText = document.querySelector('#prompt-text');
const promptKana = document.querySelector('#prompt-kana');
const progressLabel = document.querySelector('#progress-label');
const metricsNode = document.querySelector('#metrics');
const savedResultsNode = document.querySelector('#saved-results');
const savedResultsStatus = document.querySelector('#saved-results-status');
const downloadAgainButton = document.querySelector('#download-again');
const resultsStorageKey = 'transcription:last-completed-results';

const csvResponse = await fetch('./src/assets/data/phrase_set.csv');
if (!csvResponse.ok) throw new Error('フレーズセットを読み込めませんでした');
const phrases = parsePhrases(await csvResponse.text()).filter(p => p.study === '1' && p.type === 'practice' && p.set === '1');
if (!phrases.length) throw new Error('フレーズセットにデータがありません');

let participantId = '';
let index = 0;
let state = 'waiting';
let startedAt = null;
let lastChangedAt = null;
let previousValue = '';
let committedChars = 0;
let fixCount = 0;
let rows = [];
let composing = false;
let compositionSettling = false;
let compositionBaseline = '';
let compositionTimer = null;
let compositionObservedValue = '';
let compositionText = '';
let pendingCompositionDelete = 0;
let deferredCompositionDelete = 0;
let compositionDeleteTimer = null;
let savedResults = null;
restoreSavedResults();

downloadAgainButton.addEventListener('click', () => {
  if (savedResults) downloadResults(savedResults);
});

function parsePhrases(csv) {
  const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const headers = lines.shift().split(',');
  return lines.map(line => {
    const cols = line.split(',');
    const row = Object.fromEntries(headers.map((h, i) => [h, cols[i] ?? '']));
    return { study: row.test, type: row.set_type, set: row.set_number, order: Number(row.order), text: row.sentence, kana: row.kana };
  }).sort((a, b) => a.order - b.order);
}

function beginPhrase() {
  const phrase = phrases[index];
  state = 'input'; startedAt = null; lastChangedAt = null; previousValue = ''; committedChars = 0; fixCount = 0;
  input.value = '';
  input.readOnly = false;
  composing = false; compositionSettling = false; compositionBaseline = ''; compositionObservedValue = '';
  compositionText = ''; pendingCompositionDelete = 0;
  clearDeferredCompositionDelete();
  if (compositionTimer !== null) clearTimeout(compositionTimer);
  compositionTimer = null;
  input.hidden = false; input.classList.remove('result-colored'); coloredOutput.hidden = true; coloredOutput.replaceChildren();
  promptText.textContent = phrase.text;
  promptKana.textContent = phrase.kana;
  progressLabel.textContent = `${index + 1} / ${phrases.length}`;
  metricsNode.hidden = true; metricsNode.replaceChildren();
  actionButton.textContent = 'Submit';
  actionButton.disabled = true;
  resultCancel.hidden = true;
}

function showTask() { waitingScreen.hidden = true; taskScreen.hidden = false; }
function resetTask() {
  state = 'waiting'; taskScreen.hidden = true; waitingScreen.hidden = false;
  input.blur(); input.value = ''; rows = []; index = 0;
  input.hidden = false; coloredOutput.hidden = true;
}

startButton.addEventListener('click', () => {
  const value = participantInput.value.trim();
  if (!value) {
    participantInput.setCustomValidity('参加者 ID を入力してください');
    participantInput.reportValidity();
    return;
  }
  participantInput.setCustomValidity(''); participantId = value; index = 0; rows = [];
  beginPhrase(); showTask();
});
participantInput.addEventListener('input', () => participantInput.setCustomValidity(''));

input.addEventListener('focus', () => {
  if (state === 'input' && startedAt === null) startedAt = performance.now();
});
input.addEventListener('compositionstart', event => {
  if (state !== 'input') return;
  if (compositionSettling) flushComposition();
  settleDeferredCompositionDelete();
  composing = true;
  compositionBaseline = input.value;
  compositionObservedValue = input.value;
  compositionText = event.data || '';
});
input.addEventListener('beforeinput', event => {
  if (state !== 'input' || !event.inputType.startsWith('delete')) return;
  // Safari emits deleteCompositionText when it replaces provisional IME text
  // with its confirmed form. That is not a user correction.
  const selectionLength = Math.abs(input.selectionEnd - input.selectionStart);
  const deleted = selectionLength || 1;
  if (composing || event.isComposing) {
    // Wait for the accompanying composition update before recording it.
    // This prevents a cancelled browser edit from becoming a false correction.
    if (event.inputType !== 'deleteCompositionText') pendingCompositionDelete += deleted;
  }
});
input.addEventListener('compositionupdate', event => {
  if (state !== 'input') return;
  const next = event.data || '';
  const shrankFromEnd = next.length < compositionText.length && compositionText.startsWith(next);

  if (pendingCompositionDelete > 0 && (shrankFromEnd || next !== compositionText)) {
    recordCompositionCorrection(pendingCompositionDelete);
    pendingCompositionDelete = 0;
  } else if (next.length > 0 && shrankFromEnd) {
    // Some iOS IMEs label a real Backspace as deleteCompositionText. The
    // composition text becoming a shorter prefix distinguishes it from the
    // internal clear-and-commit sequence used when confirming a candidate.
    recordCompositionCorrection(compositionText.length - next.length);
  } else if (shrankFromEnd) {
    deferCompositionDelete(compositionText.length);
  }
  compositionText = next;
});
input.addEventListener('compositionend', event => {
  if (state !== 'input') return;
  // A nonempty committed string identifies an IME clear-and-commit, even
  // when the final DOM input event arrives after compositionend.
  if (event.data) clearDeferredCompositionDelete();
  composing = false;
  compositionSettling = true;
  // Browsers may dispatch the final input event just before or just after compositionend.
  // Read the settled value once, then make later input events compare against it.
  compositionTimer = setTimeout(() => {
    if (state !== 'input') return;
    flushComposition();
  }, 0);
});
input.addEventListener('input', event => {
  if (state !== 'input') return;
  // Once typing starts, keep Submit enabled even if all text is deleted.
  if (input.value.length > 0) actionButton.disabled = false;
  if (composing || event.isComposing) {
    const value = input.value;
    if (pendingCompositionDelete > 0 && value !== compositionObservedValue) {
      recordCompositionCorrection(pendingCompositionDelete);
      pendingCompositionDelete = 0;
      if (value === compositionBaseline) compositionText = '';
    } else if (event.inputType === 'deleteCompositionText' &&
        value === compositionBaseline && value !== compositionObservedValue &&
        compositionText.length > 0 && deferredCompositionDelete === 0) {
      // Also handle keyboards which clear the DOM without compositionupdate.
      deferCompositionDelete(changedMiddle(compositionObservedValue, value).removed);
      compositionText = '';
    }
    if (value !== compositionObservedValue) {
      if (startedAt === null) startedAt = performance.now();
      lastChangedAt = performance.now();
      compositionObservedValue = value;
    }
    return;
  }
  if (compositionSettling) return;
  if (startedAt === null) startedAt = performance.now();
  const value = input.value;
  // Outside an IME composition, the applied DOM value is the source of truth.
  accountValueChange(previousValue, value);
  if (value !== previousValue) lastChangedAt = performance.now();
  previousValue = value;
});

function accountValueChange(before, after, changedAt = performance.now()) {
  if (after === before) return;
  if (startedAt === null) startedAt = performance.now();
  const { removed, inserted } = changedMiddle(before, after);
  committedChars += inserted;
  if (removed > 0) {
    recordCorrectionOfCommittedText();
  }
  lastChangedAt = changedAt;
}

function recordCorrectionOfCommittedText() {
  // The removed characters were already included when they were committed.
  // Add the single correction operation required by the IF formula.
  committedChars += 1;
  fixCount += 1;
}

function recordCompositionCorrection(deletedCharacters) {
  // Provisional IME text has not yet entered the stream. Include the removed
  // characters and the correction operation so that IF records the deletion.
  committedChars += deletedCharacters + 1;
  fixCount += 1;
}

function clearDeferredCompositionDelete() {
  if (compositionDeleteTimer !== null) clearTimeout(compositionDeleteTimer);
  compositionDeleteTimer = null;
  deferredCompositionDelete = 0;
}

function deferCompositionDelete(deletedCharacters) {
  if (deferredCompositionDelete > 0 || deletedCharacters === 0) return;
  deferredCompositionDelete = deletedCharacters;
  // IME confirmation can temporarily clear the same text as Backspace.
  // Inspect the settled DOM after the clear-and-commit event sequence.
  compositionDeleteTimer = setTimeout(() => {
    if (state === 'input') settleDeferredCompositionDelete();
    else clearDeferredCompositionDelete();
  }, 0);
}

function settleDeferredCompositionDelete() {
  const deleted = deferredCompositionDelete;
  clearDeferredCompositionDelete();
  if (deleted > 0 && input.value === compositionBaseline) {
    recordCompositionCorrection(deleted);
  }
}

function flushComposition() {
  if (compositionTimer !== null) clearTimeout(compositionTimer);
  compositionTimer = null;
  settleDeferredCompositionDelete();
  if (composing || compositionSettling) {
    const value = input.value;
    const finalChangeWasUnobserved = value !== compositionObservedValue;
    const changeTime = finalChangeWasUnobserved ? performance.now() : lastChangedAt;
    const { inserted } = changedMiddle(compositionBaseline, value);
    committedChars += inserted;
    if (value !== compositionBaseline) {
      if (startedAt === null) startedAt = performance.now();
      lastChangedAt = changeTime ?? performance.now();
    }
    previousValue = input.value;
  }
  composing = false;
  compositionSettling = false;
  compositionBaseline = '';
  compositionObservedValue = '';
  compositionText = '';
  pendingCompositionDelete = 0;
}

function changedMiddle(before, after) {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return { removed: before.length - prefix - suffix, inserted: after.length - prefix - suffix };
}

actionButton.addEventListener('click', () => {
  if (actionButton.disabled) return;
  if (state === 'input') showResult();
  else if (state === 'result') {
    index += 1;
    if (index >= phrases.length) {
      saveCompletedResults();
      resetTask();
      downloadResults(savedResults);
    }
    else beginPhrase();
  }
});
taskCancel.addEventListener('click', resetTask);
resultCancel.addEventListener('click', resetTask);

function showResult() {
  // Submit may arrive while the IME still owns an uncommitted composition.
  flushComposition();
  const phrase = phrases[index];
  const typed = input.value;
  const diff = align(phrase.kana, typed);
  const inf = diff.stats.ins + diff.stats.sub + diff.stats.del;
  const correct = typed.length - diff.stats.ins - diff.stats.sub;
  const incorrectFixed = Math.max(0, committedChars - fixCount - typed.length);
  const elapsed = startedAt !== null && lastChangedAt !== null ? Math.max(0, (lastChangedAt - startedAt) / 1000) : 0;
  const duration = Math.max(.001, elapsed);
  const cpm = typed.length / duration * 60;
  const ter = correct + inf + incorrectFixed > 0 ? (inf + incorrectFixed) / (correct + inf + incorrectFixed) * 100 : 0;
  renderFeedback(typed, diff.alignment);
  renderMetrics({ time: elapsed, cpm, ter, f: fixCount, c: correct, inf, incorrectFixed });
  rows.push({ participant_id: participantId, study: phrase.study, set_type: phrase.type, set_number: phrase.set, phrase_order: phrase.order, presented_text: phrase.text, reference_text: phrase.kana, submitted_text: typed, time_s: elapsed, cpm, ter_percent: ter, f: fixCount, c: correct, inf, if: incorrectFixed });
  state = 'result'; input.readOnly = true; actionButton.textContent = 'Next'; resultCancel.hidden = false;
}

function renderFeedback(text, alignment) {
  coloredOutput.replaceChildren();
  for (const part of alignment) {
    const span = document.createElement('span');
    if (part.type === 'INS') span.className = 'ins';
    if (part.type === 'SUB') span.className = 'sub';
    if (part.type === 'DEL') {
      span.className = 'del';
      span.textContent = phrases[index].kana[part.s];
    } else {
      span.textContent = text[part.t];
    }
    coloredOutput.append(span);
  }
  input.value = text;
  input.hidden = true; coloredOutput.hidden = false;
  input.setAttribute('aria-label', `入力結果: ${text}`);
  promptKana.textContent = phrases[index].kana;
}

function renderMetrics(m) {
  metricsNode.replaceChildren(); metricsNode.hidden = false;
  const items = [['Time', `${m.time.toFixed(2)} s`], ['CPM', `${m.cpm.toFixed(2)} /min`], ['TER', `${m.ter.toFixed(2)}%`], ['F', m.f], ['C', m.c], ['INF', m.inf], ['IF', m.incorrectFixed]];
  for (const [label, value] of items) {
    const item = document.createElement('div'); item.className = 'metric';
    const title = document.createElement('span'); title.textContent = label;
    const strong = document.createElement('strong'); strong.textContent = value;
    item.append(title, strong); metricsNode.append(item);
  }
}

function align(source, target) {
  const n = source.length, m = target.length;
  const d = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (source[i - 1] === target[j - 1] ? 0 : 1));
  const alignment = []; const stats = { ins: 0, sub: 0, del: 0 };
  let i = n, j = m;
  while (i || j) {
    if (i && j) {
      const cost = source[i - 1] === target[j - 1] ? 0 : 1;
      if (d[i][j] === d[i - 1][j - 1] + cost) {
        const type = cost ? 'SUB' : 'COR'; if (cost) stats.sub++;
        alignment.push({ type, s: i - 1, t: j - 1 }); i--; j--; continue;
      }
    }
    if (i && d[i][j] === d[i - 1][j] + 1) { stats.del++; alignment.push({ type: 'DEL', s: i - 1, t: -1 }); i--; continue; }
    stats.ins++; alignment.push({ type: 'INS', s: -1, t: j - 1 }); j--;
  }
  return { alignment: alignment.reverse(), stats };
}

function restoreSavedResults() {
  try {
    const stored = JSON.parse(localStorage.getItem(resultsStorageKey));
    if (!stored || typeof stored.csv !== 'string' || typeof stored.filename !== 'string' ||
        typeof stored.participantId !== 'string') return;
    savedResults = stored;
    showSavedResults(true);
  } catch {
    // An unavailable storage area must not prevent the task from starting.
  }
}

function showSavedResults(persisted) {
  savedResultsNode.hidden = false;
  savedResultsStatus.textContent = `参加者 ID: ${savedResults.participantId} の直近の完了記録を再ダウンロードできます。` +
    (persisted ? '' : ' ブラウザ内に保存できなかったため、ページを閉じたり再読み込みしたりする前にダウンロードしてください。');
}

function saveCompletedResults() {
  const columns = ['participant_id', 'study', 'set_type', 'set_number', 'phrase_order', 'presented_text', 'reference_text', 'submitted_text', 'time_s', 'cpm', 'ter_percent', 'f', 'c', 'inf', 'if'];
  const escape = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const csv = [columns, ...rows.map(row => columns.map(c => row[c]))].map(row => row.map(escape).join(',')).join('\r\n');
  savedResults = {
    participantId,
    csv: '\uFEFF' + csv,
    filename: `transcription_${safeFilename(participantId)}_${new Date().toISOString().replaceAll(':', '-')}.csv`,
  };
  let persisted = false;
  try {
    localStorage.setItem(resultsStorageKey, JSON.stringify(savedResults));
    persisted = true;
  } catch {
    // Keep the in-memory copy available even when persistent storage is full or blocked.
  }
  showSavedResults(persisted);
}

function downloadResults(result) {
  const url = URL.createObjectURL(new Blob([result.csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = result.filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function safeFilename(value) { return value.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 60) || 'participant'; }
