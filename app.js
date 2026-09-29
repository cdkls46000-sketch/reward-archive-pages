/*
 * Prototype storage layer
 * -----------------------
 * Metadata is kept in localStorage and uploaded files in IndexedDB for now.
 * The UI talks to this small layer instead of directly to a provider, so it
 * can be replaced with Google Drive + Sheets later without redesigning pages.
 */
(function () {
  'use strict';

  const YEARS = [2568, 2569, 2570, 2571];
  const META_KEY = 'communicable-disease-rewards-v1';
  const DB_NAME = 'communicable-disease-rewards-files';
  const DB_VERSION = 1;
  const STORE = 'files';
  const DEFAULT_PROFILE = { id: 'local-user', name: 'เจ้าหน้าที่', email: '' };
  const TYPE_OPTIONS = ['โครงการ', 'กิจกรรม', 'วิจัย', 'นวัตกรรม', 'งานวิชาการ', 'พัฒนาระบบ', 'อื่น ๆ'];
  const CATEGORY_OPTIONS = ['การเฝ้าระวังโรค', 'การป้องกันควบคุมโรค', 'งานระบาดวิทยา', 'พัฒนาระบบบริการ', 'วิชาการและวิจัย', 'อื่น ๆ'];

  const state = {
    works: [],
    awards: [],
    staff: structuredClone(window.REWARD_STAFF || []),
    staffFilter: 'all',
    profile: { ...DEFAULT_PROFILE },
    view: 'overview',
    search: '',
    workYear: 'all',
    workType: 'all',
    workCategory: 'all',
    awardYear: 'all',
    annualYear: 2568,
    editingId: null,
    editingAwardId: null,
    pendingFiles: [],
    existingAttachments: [],
    cloud: { connected: false, configured: false, revision: null, busy: false, message: '', csrf: '' },
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const esc = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const nowISO = () => new Date().toISOString();
  const yearLabel = (year) => year ? `พ.ศ. ${year}` : 'ไม่ระบุปี';
  const formatDate = (value) => {
    if (!value) return 'ไม่ระบุวันที่';
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const formatBytes = (bytes = 0) => {
    if (!bytes) return '0 KB';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
  };
  const statusLabel = (status) => status === 'draft' ? 'ร่าง' : status === 'trashed' ? 'ถังขยะ' : 'เผยแพร่';
  const isVisible = (item) => item.status !== 'trashed';
  const publishedWorks = () => state.works.filter((work) => work.status === 'published');
  const publishedAwards = () => state.awards.filter((award) => award.status === 'published');

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(META_KEY) || '{}');
      state.works = Array.isArray(saved.works) ? saved.works : [];
      state.awards = Array.isArray(saved.awards) ? saved.awards : [];
      state.profile = { ...DEFAULT_PROFILE, ...(saved.profile || {}) };
      if (Array.isArray(saved.staff)) state.staff = saved.staff;
    } catch (error) {
      console.warn('Could not load prototype data', error);
    }
  }

  function saveState() {
    localStorage.setItem(META_KEY, JSON.stringify({ works: state.works, awards: state.awards, profile: state.profile, staff: state.staff }));
    updateProfileUI();
    updateStorageUI();
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('เบราว์เซอร์นี้ไม่รองรับ IndexedDB'));
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function putBlob(blob, metadata = {}) {
    const id = uid('file');
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put({ id, blob, ...metadata });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    return id;
  }

  async function getBlob(id) {
    if (!id) return null;
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.warn('Could not load file', error);
      return null;
    }
  }

  async function deleteBlob(id) {
    if (!id) return;
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        transaction.objectStore(STORE).delete(id);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
    } catch (error) { console.warn('Could not delete file', error); }
  }

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  async function compressImage(file) {
    if (!file.type.startsWith('image/') || file.type === 'image/svg+xml' || file.size < 450 * 1024) return file;
    try {
      const dataUrl = await readAsDataURL(file);
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = dataUrl;
      });
      const maxSide = 1920;
      const ratio = Math.min(1, maxSide / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * ratio));
      canvas.height = Math.max(1, Math.round(image.height * ratio));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', .82));
      return blob || file;
    } catch (error) {
      return file;
    }
  }

  async function saveFiles(files) {
    const attachments = [];
    for (const file of files) {
      const blob = await compressImage(file);
      const fileId = await putBlob(blob, { name: file.name, originalName: file.name, type: blob.type || file.type, size: blob.size || file.size });
      attachments.push({ fileId, name: file.name, type: blob.type || file.type, size: blob.size || file.size, kind: (file.type || '').startsWith('image/') ? 'image' : 'document', caption: '' });
    }
    return attachments;
  }

  async function getObjectURL(attachment) {
    if (!attachment) return '';
    const stored = await getBlob(attachment.fileId);
    if (!stored || !stored.blob) {
      const source = [...state.works, ...state.awards].flatMap(item => item.attachments || []).find(file => file.fileId === attachment.fileId);
      if (!source?.driveId || !state.cloud.connected) return '';
      try {
        const response = await fetch(`/api/files/${encodeURIComponent(source.driveId)}`);
        if (!response.ok) return '';
        const bytes = await response.arrayBuffer();
        return URL.createObjectURL(new Blob([bytes], { type: source.type || 'application/octet-stream' }));
      } catch { return ''; }
    }
    return URL.createObjectURL(stored.blob);
  }

  async function hydrateImages(root = document) {
    const elements = $$('[data-file-id]', root);
    await Promise.all(elements.map(async (element) => {
      const url = await getObjectURL({ fileId: element.dataset.fileId });
      if (url) {
        element.src = url;
        element.classList.add('loaded');
      } else {
        element.removeAttribute('src');
      }
    }));
  }

  async function hydrateDownloads(root = document) {
    const elements = $$('[data-download-id]', root);
    await Promise.all(elements.map(async (element) => {
      const url = await getObjectURL({ fileId: element.dataset.downloadId });
      if (url) {
        element.href = url;
        element.download = element.dataset.fileName || 'เอกสาร';
      }
    }));
  }

  function updateProfileUI() {
    const name = state.profile.name || DEFAULT_PROFILE.name;
    $('#profileName').textContent = name;
    $('#profileInitial').textContent = name.trim().charAt(0) || 'จ';
  }

  function updateStorageUI() {
    const bytes = [...state.works, ...state.awards].reduce((sum, item) => sum + (item.attachments || []).reduce((a, file) => a + Number(file.size || 0), 0), 0);
    const limit = 500 * 1024 * 1024;
    $('#storageText').textContent = formatBytes(bytes);
    $('#storageBar').style.width = `${Math.min(100, (bytes / limit) * 100)}%`;
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    $('#toastRegion').appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  function setView(view) {
    state.view = view;
    $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
    $$('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
    const labels = { overview: 'ภาพรวม', works: 'ผลงาน', awards: 'รางวัล', annual: 'สรุปรายปี', mine: 'ผลงานของฉัน', staff: 'บุคลากรและงานรับผิดชอบ', connection: 'เชื่อมต่อ Google Drive' };
    $('#pageKicker').textContent = labels[view] || 'ภาพรวม';
    if (view === 'overview') renderOverview();
    if (view === 'works') renderWorks();
    if (view === 'awards') renderAwards();
    if (view === 'annual') renderAnnual();
    if (view === 'mine') renderMine();
    if (view === 'staff') renderStaff();
    if (view === 'connection') renderConnection();
  }

  function emptyState(icon, title, message, action = '') {
    return `<div class="empty-state"><div class="empty-icon">${icon}</div><h3>${esc(title)}</h3><p>${esc(message)}</p>${action}</div>`;
  }

  function workImageMarkup(work, extraClass = '') {
    const cover = (work.attachments || []).find((file) => file.kind === 'image');
    if (!cover) return `<div class="work-image ${extraClass}">✦</div>`;
    return `<div class="work-image ${extraClass}"><img data-file-id="${esc(cover.fileId)}" alt="${esc(cover.caption || work.title)}" /></div>`;
  }

  function renderOverview() {
    const works = publishedWorks();
    const awards = publishedAwards();
    const allContributors = new Set(works.flatMap((work) => [work.owner, ...(work.contributors || [])].filter(Boolean)));
    const categories = CATEGORY_OPTIONS.map((category) => ({ category, count: works.filter((work) => work.category === category).length })).filter((item) => item.count);
    const maxCategory = Math.max(1, ...categories.map((item) => item.count));
    const yearRows = YEARS.map((year) => ({ year, works: works.filter((work) => Number(work.year) === year).length, awards: awards.filter((award) => Number(award.year) === year).length }));
    const maxYear = Math.max(1, ...yearRows.flatMap((row) => [row.works, row.awards]));
    const featured = works.filter((work) => work.featured).slice(0, 3);
    const latest = [...works].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 3);
    $('#view-overview').innerHTML = `
      <div class="hero"><div><p class="eyebrow">ศูนย์รวมผลงานและความสำเร็จ</p><h1>ภาพรวมผลงานกลุ่มงาน</h1><p class="hero-copy">ติดตามรางวัลและผลงานสำคัญในปี 2568–2571 ได้จากหน้าเดียว</p></div><button class="primary-button" data-action="add-work">＋ เพิ่มผลงาน</button></div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-top"><span>ผลงานเผยแพร่</span><span class="stat-icon">✦</span></div><strong>${works.length}</strong><span class="stat-caption">รายการในคลังทั้งหมด</span></div>
        <div class="stat-card"><div class="stat-top"><span>รางวัล</span><span class="stat-icon" style="background:var(--gold-soft);color:var(--gold)">🏆</span></div><strong>${awards.length}</strong><span class="stat-caption">รางวัลที่บันทึกไว้</span></div>
        <div class="stat-card"><div class="stat-top"><span>ผู้มีส่วนร่วม</span><span class="stat-icon">◎</span></div><strong>${allContributors.size}</strong><span class="stat-caption">บุคลากรไม่ซ้ำ</span></div>
        <div class="stat-card"><div class="stat-top"><span>ปีที่มีข้อมูล</span><span class="stat-icon">▤</span></div><strong>${new Set(works.map((work) => work.year).filter(Boolean)).size}<small style="font:400 13px 'Sarabun'"> / 4 ปี</small></strong><span class="stat-caption">พ.ศ. 2568–2571</span></div>
      </div>
      <div class="content-grid">
        <section class="panel"><div class="panel-head"><div><h2>ผลงานและรางวัลแยกรายปี</h2><p class="panel-subtitle">ข้อมูลจากรายการที่เผยแพร่</p></div><button class="text-button" data-view="annual">ดูรายปี →</button></div>
          <div class="bar-chart">${yearRows.map((row) => `<div class="bar-group"><span class="bar-value">${row.works + row.awards || ''}</span><div class="bars"><span class="bar" title="ผลงาน ${row.works}" style="height:${Math.max(3, (row.works / maxYear) * 100)}%"></span><span class="bar award" title="รางวัล ${row.awards}" style="height:${Math.max(3, (row.awards / maxYear) * 100)}%"></span></div><span class="bar-label">${row.year}</span></div>`).join('')}</div>
          <div class="legend"><span><i></i>ผลงาน</span><span><i class="gold"></i>รางวัล</span></div>
        </section>
        <section class="panel"><div class="panel-head"><div><h2>ผลงานตามหมวดงาน</h2><p class="panel-subtitle">ดูสัดส่วนของผลงานที่เผยแพร่</p></div></div>
          ${categories.length ? `<div class="category-list">${categories.slice(0, 6).map((item) => `<div class="category-row"><span>${esc(item.category)}</span><strong>${item.count}</strong><div class="category-track"><span style="width:${(item.count / maxCategory) * 100}%"></span></div></div>`).join('')}</div>` : emptyState('◌', 'ยังไม่มีข้อมูลหมวดงาน', 'เพิ่มผลงานแรกเพื่อเริ่มดูภาพรวม')}
        </section>
      </div>
      <section class="panel"><div class="panel-head"><div><h2>ผลงานเด่น</h2><p class="panel-subtitle">เลือกทำเครื่องหมาย “ผลงานเด่น” จากหน้าฟอร์มได้</p></div><button class="text-button" data-view="works">ดูทั้งหมด →</button></div>
        ${featured.length ? `<div class="work-cards">${featured.map(workCardMarkup).join('')}</div>` : emptyState('✦', 'ยังไม่มีผลงานเด่น', 'เพิ่มผลงานแล้วเลือกทำเครื่องหมายเป็นผลงานเด่นได้', '<button class="secondary-button" data-action="add-work">เพิ่มผลงาน</button>')}
      </section>
      <section class="panel" style="margin-top:17px"><div class="panel-head"><div><h2>เพิ่มล่าสุด</h2><p class="panel-subtitle">รายการที่แก้ไขล่าสุดในคลัง</p></div></div>
        ${latest.length ? `<div class="work-cards">${latest.map(workCardMarkup).join('')}</div>` : emptyState('＋', 'คลังยังว่างอยู่', 'เริ่มเก็บผลงานและรางวัลของกลุ่มงานได้จากปุ่มด้านบน', '<button class="primary-button" data-action="add-work">เพิ่มผลงานแรก</button>')}
      </section>`;
    hydrateImages($('#view-overview'));
  }

  function workCardMarkup(work) {
    return `<article class="work-card" data-action="view-work" data-id="${esc(work.id)}">${workImageMarkup(work)}<div class="work-card-body"><h3>${esc(work.title)}</h3><p>${esc(work.summary || 'ยังไม่มีบทสรุป')}</p><div class="card-meta"><span>${yearLabel(work.year)}</span><span class="pill">${esc(work.type || 'ผลงาน')}</span></div></div></article>`;
  }

  function filterOptions(options, selected, allLabel = 'ทั้งหมด') {
    return [`<option value="all">${allLabel}</option>`, ...options.map((option) => `<option value="${esc(option)}" ${String(option) === String(selected) ? 'selected' : ''}>${esc(option)}</option>`)].join('');
  }

  function renderWorks() {
    const query = state.search.trim().toLowerCase();
    let works = publishedWorks().filter((work) => {
      const haystack = [work.title, work.summary, work.owner, work.category, work.type, work.responsibility, ...(work.contributors || [])].join(' ').toLowerCase();
      return (!query || haystack.includes(query)) && (state.workYear === 'all' || String(work.year) === String(state.workYear)) && (state.workType === 'all' || work.type === state.workType) && (state.workCategory === 'all' || work.category === state.workCategory);
    }).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const selectedPerson = state.staff.find(p => p.id === state.staffFilter);
    if (selectedPerson) works = works.filter(w => w.ownerId === selectedPerson.id || w.owner === selectedPerson.name || (w.contributorIds || []).includes(selectedPerson.id) || (w.contributors || []).includes(selectedPerson.name));
    $('#view-works').innerHTML = `
      ${selectedPerson ? `<div class="notice">ผลงานของ ${esc(selectedPerson.name)} <button class="text-button" data-action="clear-person-filter">แสดงทุกคน</button></div>` : ''}
      <div class="hero"><div><p class="eyebrow">คลังข้อมูล</p><h1>ผลงานทั้งหมด</h1><p class="hero-copy">ค้นหาและเปิดดูผลงานที่เผยแพร่แล้ว พร้อมหลักฐานประกอบ</p></div><button class="primary-button" data-action="add-work">＋ เพิ่มผลงาน</button></div>
      <section class="panel"><div class="filter-row"><input class="grow" id="worksSearch" type="search" value="${esc(state.search)}" placeholder="ค้นหาชื่อ บทสรุป เจ้าของ หรือหมวดงาน..." /><select id="workYearFilter">${filterOptions(YEARS, state.workYear, 'ทุกปี')}</select><select id="workTypeFilter">${filterOptions(TYPE_OPTIONS, state.workType, 'ทุกประเภท')}</select><select id="workCategoryFilter">${filterOptions(CATEGORY_OPTIONS, state.workCategory, 'ทุกหมวด')}</select></div>
      ${works.length ? `<div class="table-wrap"><table><thead><tr><th>ผลงาน</th><th>ประเภท / หมวด</th><th>ปี</th><th>เจ้าของผลงาน</th><th>แก้ไขล่าสุด</th><th></th></tr></thead><tbody>${works.map((work) => `<tr><td><strong>${esc(work.title)}</strong><br><span style="font-size:11px;color:#93a5a3">${esc(work.summary || 'ไม่มีบทสรุป')}</span></td><td><span class="pill">${esc(work.type || 'ไม่ระบุ')}</span><br><span style="font-size:10px;color:#93a5a3">${esc(work.category || 'ไม่ระบุ')}</span></td><td>${yearLabel(work.year)}</td><td>${esc(work.owner || 'ไม่ระบุ')}</td><td>${formatDate((work.updatedAt || '').slice(0, 10))}</td><td><div class="row-actions"><button class="small-button" data-action="view-work" data-id="${esc(work.id)}">เปิด</button><button class="small-button" data-action="edit-work" data-id="${esc(work.id)}">แก้ไข</button></div></td></tr>`).join('')}</tbody></table></div>` : emptyState('✦', 'ยังไม่มีผลงานที่ตรงกับการค้นหา', 'ลองเปลี่ยนตัวกรอง หรือเพิ่มผลงานรายการแรก', '<button class="primary-button" data-action="add-work">＋ เพิ่มผลงาน</button>')}
      </section>`;
  }

  function renderAwards() {
    const query = state.search.trim().toLowerCase();
    let awards = publishedAwards().filter((award) => {
      const haystack = [award.title, award.issuer, award.level, award.recipients, award.relatedWorkTitle].join(' ').toLowerCase();
      return (!query || haystack.includes(query)) && (state.awardYear === 'all' || String(award.year) === String(state.awardYear));
    }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    $('#view-awards').innerHTML = `
      <div class="hero"><div><p class="eyebrow">ความสำเร็จของกลุ่มงาน</p><h1>รางวัล</h1><p class="hero-copy">รวมรางวัล เกียรติบัตร และการยอมรับที่เกี่ยวข้องกับผลงาน</p></div><button class="primary-button" data-action="add-award">＋ เพิ่มรางวัล</button></div>
      <section class="panel"><div class="filter-row"><input class="grow" id="awardSearch" type="search" value="${esc(state.search)}" placeholder="ค้นหาชื่อรางวัล หน่วยงานผู้มอบ หรือผู้รับ..." /><select id="awardYearFilter">${filterOptions(YEARS, state.awardYear, 'ทุกปี')}</select></div>
      ${awards.length ? `<div class="table-wrap"><table><thead><tr><th>รางวัล</th><th>หน่วยงานผู้มอบ</th><th>ระดับ</th><th>ผู้รับ</th><th>ปี</th><th></th></tr></thead><tbody>${awards.map((award) => `<tr><td><strong>${esc(award.title)}</strong><br><span style="font-size:11px;color:#93a5a3">${esc(award.description || 'ไม่มีรายละเอียด')}</span></td><td>${esc(award.issuer || 'ไม่ระบุ')}</td><td><span class="pill gold">${esc(award.level || 'ไม่ระบุ')}</span></td><td>${esc(award.recipients || 'ไม่ระบุ')}</td><td>${yearLabel(award.year)}</td><td><div class="row-actions"><button class="small-button" data-action="view-award" data-id="${esc(award.id)}">เปิด</button><button class="small-button" data-action="edit-award" data-id="${esc(award.id)}">แก้ไข</button></div></td></tr>`).join('')}</tbody></table></div>` : emptyState('🏆', 'ยังไม่มีรางวัล', 'เพิ่มรางวัลและเอกสารประกอบของกลุ่มงานได้จากปุ่มด้านบน', '<button class="primary-button" data-action="add-award">＋ เพิ่มรางวัล</button>')}
      </section>`;
  }

  function renderAnnual() {
    const works = publishedWorks();
    const awards = publishedAwards();
    const year = state.annualYear;
    const yearWorks = works.filter((work) => Number(work.year) === Number(year));
    const yearAwards = awards.filter((award) => Number(award.year) === Number(year));
    const timeline = [...yearWorks.map((work) => ({ date: work.date, title: work.title, type: work.type || 'ผลงาน' })), ...yearAwards.map((award) => ({ date: award.date, title: award.title, type: 'รางวัล' }))].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    $('#view-annual').innerHTML = `
      <div class="hero"><div><p class="eyebrow">สรุปเพื่อการติดตามและประเมิน</p><h1>สรุปรายปี</h1><p class="hero-copy">เลือกปีเพื่อดูจำนวนผลงาน ความสำเร็จ และเหตุการณ์สำคัญ</p></div><button class="secondary-button" data-action="print-current-annual">🖨 พิมพ์สรุปปี ${year}</button></div>
      <div class="annual-grid">${YEARS.map((itemYear) => { const count = works.filter((work) => Number(work.year) === itemYear).length; return `<button class="year-card ${itemYear === year ? 'selected' : ''}" data-action="select-year" data-year="${itemYear}"><span>${itemYear}</span><small>ปีงบประมาณ</small><strong>${count}</strong><small>ผลงานเผยแพร่</small></button>`; }).join('')}</div>
      <div class="stats-grid"><div class="stat-card"><div class="stat-top"><span>ผลงานในปี ${year}</span><span class="stat-icon">✦</span></div><strong>${yearWorks.length}</strong><span class="stat-caption">รายการ</span></div><div class="stat-card"><div class="stat-top"><span>รางวัลในปี ${year}</span><span class="stat-icon" style="background:var(--gold-soft);color:var(--gold)">🏆</span></div><strong>${yearAwards.length}</strong><span class="stat-caption">รางวัล</span></div><div class="stat-card"><div class="stat-top"><span>ผู้ร่วมงาน</span><span class="stat-icon">◎</span></div><strong>${new Set(yearWorks.flatMap((work) => [work.owner, ...(work.contributors || [])]).filter(Boolean)).size}</strong><span class="stat-caption">บุคลากรไม่ซ้ำ</span></div><div class="stat-card"><div class="stat-top"><span>หลักฐานภาพและเอกสาร</span><span class="stat-icon">▧</span></div><strong>${yearWorks.reduce((total, work) => total + (work.attachments || []).length, 0)}</strong><span class="stat-caption">ไฟล์แนบ</span></div></div>
      <div class="content-grid"><section class="panel"><div class="panel-head"><div><h2>ลำดับเหตุการณ์ปี ${year}</h2><p class="panel-subtitle">เรียงตามวันที่ที่บันทึกในรายการ</p></div></div>${timeline.length ? `<div class="timeline">${timeline.map((item) => `<div class="timeline-item"><span class="timeline-date">${formatDate(item.date)}</span><span class="timeline-dot"></span><div class="timeline-body"><strong>${esc(item.title)}</strong><span>${esc(item.type)}</span></div></div>`).join('')}</div>` : emptyState('▤', `ยังไม่มีข้อมูลปี ${year}`, 'เพิ่มผลงานหรือรางวัลแล้วข้อมูลจะปรากฏที่หน้านี้')}</section><section class="panel"><div class="panel-head"><div><h2>ผลงานในปี ${year}</h2><p class="panel-subtitle">เปิดดูรายละเอียดและหลักฐานได้</p></div></div>${yearWorks.length ? `<div class="work-cards" style="grid-template-columns:1fr">${yearWorks.slice(0, 6).map(workCardMarkup).join('')}</div>` : emptyState('✦', 'ยังไม่มีผลงาน', 'เริ่มเพิ่มผลงานสำหรับปีนี้')}</section></div>`;
    hydrateImages($('#view-annual'));
  }

  function renderMine() {
    const name = state.profile.name || DEFAULT_PROFILE.name;
    const mine = publishedWorks().filter((work) => work.owner === name || (work.contributors || []).includes(name));
    const drafts = state.works.filter((work) => work.status === 'draft' && work.owner === name);
    const trash = state.works.filter((work) => work.status === 'trashed' && work.owner === name);
    $('#view-mine').innerHTML = `
      <div class="hero"><div><p class="eyebrow">พื้นที่ของฉัน</p><h1>ผลงานของฉัน</h1><p class="hero-copy">ดูผลงานที่เป็นเจ้าของหรือมีชื่อเป็นผู้ร่วมงาน</p></div><button class="primary-button" data-action="add-work">＋ เพิ่มผลงาน</button></div>
      <div class="notice">ข้อมูลต้นแบบเก็บในเบราว์เซอร์เครื่องนี้ก่อนเชื่อม Google Drive ในขั้นถัดไป หากใช้หลายเครื่องให้ใช้ปุ่มส่งออกข้อมูลเพื่อสำรองไว้</div>
      <div class="stats-grid"><div class="stat-card"><div class="stat-top"><span>เผยแพร่แล้ว</span><span class="stat-icon">✦</span></div><strong>${mine.length}</strong><span class="stat-caption">ผลงานที่เกี่ยวข้อง</span></div><div class="stat-card"><div class="stat-top"><span>ร่าง</span><span class="stat-icon">✎</span></div><strong>${drafts.length}</strong><span class="stat-caption">กรอกต่อได้</span></div><div class="stat-card"><div class="stat-top"><span>ถังขยะ</span><span class="stat-icon">⌫</span></div><strong>${trash.length}</strong><span class="stat-caption">กู้คืนหรือลบถาวร</span></div><div class="stat-card"><div class="stat-top"><span>ชื่อผู้บันทึก</span><span class="stat-icon">◎</span></div><strong style="font-size:19px">${esc(name)}</strong><span class="stat-caption">แก้ได้ที่ตั้งค่าผู้ใช้</span></div></div>
      <section class="panel"><div class="panel-head"><div><h2>ผลงานที่เกี่ยวข้อง</h2><p class="panel-subtitle">รายการเจ้าของและผู้ร่วมงาน</p></div></div>${mine.length ? `<div class="work-cards">${mine.map(workCardMarkup).join('')}</div>` : emptyState('◎', 'ยังไม่มีผลงานของคุณ', 'เพิ่มผลงานแรกเพื่อเริ่มเก็บประวัติการทำงาน', '<button class="primary-button" data-action="add-work">เพิ่มผลงาน</button>')}</section>`;
    hydrateImages($('#view-mine'));
  }

  function openModal(content) {
    $('#modal').innerHTML = content;
    $('#modalBackdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    const focusTarget = $('#modal input, #modal select, #modal textarea, #modal button', $('#modal'));
    if (focusTarget) setTimeout(() => focusTarget.focus(), 30);
    enhanceStaffFields();
  }

  function personOptions(value = '') {
    return `<option value="">เลือกบุคลากร</option>${value && !state.staff.some(person => person.name === value) ? `<option selected value="${esc(value)}">${esc(value)} (ข้อมูลเดิม)</option>` : ''}${state.staff.map(person => `<option value="${esc(person.name)}" ${person.name === value ? 'selected' : ''}>${esc(person.name)}</option>`).join('')}`;
  }

  function enhanceStaffFields() {
    const form = $('#workForm');
    if (form) {
      const old = $('[name="owner"]', form);
      const selectedOwner = state.editingId || state.staff.some(p => p.name === old.value) ? old.value : '';
      old.outerHTML = `<select name="owner" aria-label="ผู้รับผิดชอบหลัก" required>${personOptions(selectedOwner)}</select>`;
      const person = state.staff.find(p => p.name === $('[name="owner"]', form).value);
      const helper = document.createElement('small');
      helper.id = 'ownerResponsibilities';
      helper.className = 'field-help';
      helper.textContent = person ? `งานหลัก: ${person.primary.join(' / ')}` : 'เลือกจากทะเบียนบุคลากร หรือแก้ไขรายชื่อในเมนูบุคลากร';
      $('[name="owner"]', form).parentElement.appendChild(helper);
      const work = state.works.find(w => w.id === state.editingId);
      if (!work) {
        const [year, month] = $('[name="date"]', form).value.split('-').map(Number);
        const fiscalYear = year + 543 + (month >= 10 ? 1 : 0);
        if (YEARS.includes(fiscalYear)) $('[name="year"]', form).value = String(fiscalYear);
      }
      const tasks = [...new Set(state.staff.flatMap(p => [...p.primary, ...p.secondary]))];
      const field = document.createElement('div');
      field.className = 'form-field full';
      field.innerHTML = `<label for="responsibilitySelect">งานที่เกี่ยวข้อง</label><select id="responsibilitySelect" name="responsibility"><option value="">เลือกงาน (ไม่บังคับ)</option>${tasks.map(task => `<option ${task === work?.responsibility ? 'selected' : ''}>${esc(task)}</option>`).join('')}</select>`;
      $('.form-grid', form).appendChild(field);
      const contributors = $('[name="contributors"]', form);
      const names = contributors.value.split(',').map(n => n.trim()).filter(Boolean);
      contributors.type = 'hidden';
      const group = document.createElement('fieldset');
      group.className = 'contributor-options';
      group.innerHTML = `<legend>เลือกผู้ร่วมผลงานได้หลายคน</legend>${state.staff.map(person => `<label><input type="checkbox" name="contributorId" value="${esc(person.id)}" ${names.includes(person.name) ? 'checked' : ''}> ${esc(person.name)}</label>`).join('')}`;
      contributors.parentElement.appendChild(group);
    }
    const profile = $('#profileForm');
    if (profile) {
      const old = $('[name="name"]', profile);
      old.outerHTML = `<select name="name" required aria-label="ชื่อผู้ใช้">${personOptions(old.value)}</select>`;
    }
    const awardForm = $('#awardForm');
    if (awardForm) {
      const recipients = $('[name="recipients"]', awardForm);
      recipients.setAttribute('list', 'recipientNames');
      const list = document.createElement('datalist'); list.id = 'recipientNames';
      list.innerHTML = state.staff.map(person => `<option value="${esc(person.name)}"></option>`).join('');
      recipients.after(list);
    }
    // Give every form field a usable accessible label, including legacy fields.
    $$('.form-field', $('#modal')).forEach((field, i) => {
      const input = $('input:not([type="hidden"]):not([type="checkbox"]), select, textarea', field);
      const label = $('label', field);
      if (input && label && !label.contains(input)) {
        input.id ||= `modal-field-${i}`;
        label.htmlFor = input.id;
      }
    });
  }

  function renderStaff() {
    const query = state.search.trim().toLocaleLowerCase('th');
    const persons = state.staff.filter(p => !query || [p.name, p.role, p.position, ...p.primary, ...p.secondary].join(' ').toLocaleLowerCase('th').includes(query));
    const workList = publishedWorks();
    $('#view-staff').innerHTML = `<div class="hero"><div><p class="eyebrow">สำนักงานสาธารณสุขจังหวัดกาฬสินธุ์</p><h1>บุคลากรและงานรับผิดชอบ</h1><p class="hero-copy">${state.staff.length} คน · งานหลัก งานรอง และผลงานรายบุคคล</p></div><button class="primary-button" data-action="add-person">＋ เพิ่มบุคลากร</button></div><p class="notice">รายชื่อและหน้าที่อ้างอิงจากแผนผังหน่วยงาน สามารถปรับปรุงข้อมูลได้ที่ปุ่ม “แก้ไข” และเลือกบุคลากรเป็นผู้รับผิดชอบหรือผู้ร่วมงานได้เมื่อเพิ่มผลงาน</p><div class="staff-grid">${persons.map(p => {
      const count = workList.filter(w => w.ownerId === p.id || w.owner === p.name || (w.contributorIds || []).includes(p.id) || (w.contributors || []).includes(p.name)).length;
      return `<article class="panel person-card"><div class="person-heading"><div class="person-initial">${esc(p.name.replace(/^(นางสาว|นาย|นาง)/, '').slice(0, 1))}</div><div><h2>${esc(p.name)}</h2><p>${esc(p.position)}</p><span class="pill">${esc(p.role)}</span> ${!p.verified ? '<span class="transcription-tag">รอทวนข้อมูล</span>' : ''}</div></div><h3>รับผิดชอบหลัก</h3><ul>${p.primary.map(t => `<li>${esc(t)}</li>`).join('')}</ul><h3>รับผิดชอบรอง</h3>${p.secondary.length ? `<ul>${p.secondary.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p class="field-help">ไม่มีระบุในแผนผัง</p>'}<div class="person-actions"><button class="secondary-button" data-action="person-works" data-id="${esc(p.id)}">ดู ${count} ผลงาน</button><button class="text-button" data-action="edit-person" data-id="${esc(p.id)}">แก้ไข</button></div></article>`;
    }).join('')}</div>${!persons.length ? emptyState('◎', 'ไม่พบข้อมูลบุคลากร', 'ลองค้นหาชื่อหรืองานที่รับผิดชอบอีกครั้ง') : ''}`;
  }

  function openPersonForm(id) {
    const p = state.staff.find(person => person.id === id) || { name: '', position: '', role: 'เจ้าหน้าที่', primary: [], secondary: [] };
    openModal(`<div class="modal-head"><div><h2 id="modalTitle">${id ? 'แก้ไข' : 'เพิ่ม'}บุคลากร</h2><p>ปรับชื่อ ตำแหน่ง และงานรับผิดชอบได้ โดยรหัสบุคลากรเดิมจะคงอยู่</p></div><button class="close-button" data-action="close-modal" aria-label="ปิด">×</button></div><form class="modal-body" id="personForm" data-person-id="${esc(id || '')}"><div class="form-grid"><div class="form-field full"><label>ชื่อ–สกุล</label><input name="name" required value="${esc(p.name)}"></div><div class="form-field"><label>ตำแหน่ง</label><input name="position" value="${esc(p.position)}"></div><div class="form-field"><label>หน้าที่ในกลุ่มงาน</label><input name="role" value="${esc(p.role)}"></div><div class="form-field full"><label>งานหลัก (หนึ่งงานต่อบรรทัด)</label><textarea name="primary">${esc(p.primary.join('\n'))}</textarea></div><div class="form-field full"><label>งานรอง (หนึ่งงานต่อบรรทัด)</label><textarea name="secondary">${esc(p.secondary.join('\n'))}</textarea></div><label class="check-label"><input name="verified" type="checkbox" ${p.verified ? 'checked' : ''}> ตรวจทานชื่อและหน้าที่แล้ว</label></div><div class="modal-foot"><button type="button" class="secondary-button" data-action="close-modal">ยกเลิก</button><button class="primary-button">บันทึกบุคลากร</button></div></form>`);
  }

  async function cloudRequest(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { 'X-CSRF-Token': state.cloud.csrf || '', ...(options.headers || {}) } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'ไม่สามารถเชื่อมต่อบริการได้');
    return payload;
  }

  async function renderConnection() {
    $('#view-connection').innerHTML = '<div class="panel"><h1>เชื่อมต่อ Google Drive</h1><p>กำลังตรวจสถานะ…</p></div>';
    let localBridge = false;
    if (location.protocol !== 'file:') {
      try { Object.assign(state.cloud, await cloudRequest('/api/status')); localBridge = true; } catch { /* Static hosting has no local bridge. */ }
    }
    if (!localBridge) state.cloud.connected = false;
    const c = state.cloud;
    if (state.view !== 'connection') return;
    $('#view-connection').innerHTML = `<div class="hero"><div><p class="eyebrow">พื้นที่กลางของกลุ่มงาน</p><h1>Google Drive และ Google Sheets</h1><p class="hero-copy">บัญชีปลายทาง: cdkls46000@gmail.com</p></div></div><section class="panel"><div class="connection-status ${c.connected ? '' : 'connection-error'}"><strong>${c.connected ? `เชื่อมต่อแล้ว: ${esc(c.account)}` : 'ยังไม่เชื่อมต่อ Drive ของเว็บแอป'}</strong><br>${!localBridge ? 'กรุณาเปิดเว็บผ่านตัวเริ่มระบบ START_APP.cmd ในโฟลเดอร์โครงการ เพื่อใช้ส่วนเชื่อมต่อ Google' : !c.configured ? 'ยังขาด OAuth Client ของเว็บ กรุณาทำตาม GOOGLE_DRIVE_SETUP.md แล้วเริ่มระบบใหม่' : !c.connected ? 'พร้อมเปิดหน้า Google เพื่ออนุญาตให้เว็บจัดเก็บไฟล์ในบัญชีกลุ่มงาน' : 'เชื่อมบัญชีถูกต้องแล้ว เลือกอ่านข้อมูลกลางหรือส่งข้อมูลในเครื่องขึ้น Drive'}</div><div class="connection-actions"><button class="primary-button" data-action="connect-google" ${!localBridge || !c.configured || c.busy ? 'disabled' : ''}>เชื่อมบัญชี Google</button><button class="secondary-button" data-action="cloud-load" ${!c.connected || c.busy ? 'disabled' : ''}>อ่านข้อมูลจาก Drive</button><button class="primary-button" data-action="cloud-save" ${!c.connected || c.busy ? 'disabled' : ''}>บันทึกข้อมูลและไฟล์ไป Drive</button><button class="text-button" data-view="connection">ตรวจสถานะอีกครั้ง</button></div><p class="field-help">ข้อมูลในเครื่องยังอยู่จนกว่าจะเลือกอ่านข้อมูลกลาง การบันทึกไป Drive รวมทะเบียนบุคลากร ผลงาน รางวัล และไฟล์แนบ รุ่นนี้ซิงก์เมื่อกดปุ่ม ไม่อัปโหลดอัตโนมัติ</p><p class="field-help">เมื่ออ่านข้อมูลกลาง ระบบจะสำรองรายละเอียดปัจจุบันในเครื่องก่อนเปลี่ยนชุดข้อมูล หากต้องการกลับมาใช้ชุดเดิม กดปุ่มด้านล่าง</p><button class="text-button" data-action="restore-before-cloud">คืนข้อมูลก่อนอ่าน Drive</button><p role="status" id="cloudMessage">${esc(c.message)}</p>${c.folderUrl ? `<p><a href="${esc(c.folderUrl)}" target="_blank" rel="noopener">เปิดโฟลเดอร์กลาง</a> · <a href="${esc(c.spreadsheetUrl)}" target="_blank" rel="noopener">เปิด Google Sheets</a></p>` : ''}<div class="notice">ตัวเชื่อมต่อรุ่นนี้ทำงานบนเครื่องนี้เท่านั้น ยังไม่ใช่ระบบหลายคนออนไลน์บน GitHub Pages และไม่ต้องให้เจ้าหน้าที่ใช้รหัสผ่านบัญชีกลางร่วมกัน</div></section>`;
  }

  async function connectGoogle() {
    try { const result = await cloudRequest('/api/google/connect', { method: 'POST' }); location.assign(result.url); }
    catch (error) { state.cloud.message = error.message; renderConnection(); }
  }

  async function loadCloud() {
    if (state.cloud.busy) return;
    state.cloud.busy = true;
    try {
      const result = await cloudRequest('/api/data');
      if (!['works','awards','staff'].every(key => Array.isArray(result.data?.[key]))) throw new Error('ข้อมูลบน Drive ไม่ถูกต้อง');
      if (!result.data.works.length && !result.data.awards.length && !result.data.staff.length) {
        state.cloud.revision = result.revision;
        state.cloud.message = 'Drive ยังไม่มีข้อมูล พร้อมบันทึกข้อมูลในเครื่องขึ้น Drive';
      } else {
        localStorage.setItem(`${META_KEY}-before-cloud`, JSON.stringify({ works: state.works, awards: state.awards, staff: state.staff }));
        state.works = result.data.works; state.awards = result.data.awards;
        if (result.data.staff.length) state.staff = result.data.staff;
        state.cloud.revision = result.revision;
        saveState(); state.cloud.message = 'อ่านข้อมูลกลางสำเร็จ สำรองข้อมูลในเครื่องก่อนหน้าไว้แล้ว';
      }
    } catch (error) { state.cloud.message = error.message; }
    finally { state.cloud.busy = false; renderConnection(); }
  }

  async function saveCloud() {
    if (state.cloud.busy) return;
    state.cloud.busy = true;
    try {
      // Capture a stable snapshot before asynchronous file uploads.
      const snapshot = structuredClone({ works: state.works, awards: state.awards, staff: state.staff });
      const current = await cloudRequest('/api/data');
      if (state.cloud.revision === null) {
        if (Object.values(current.data).some(rows => rows.length)) throw new Error('Drive มีข้อมูลแล้ว กรุณาอ่านข้อมูลกลางก่อน เพื่อป้องกันเขียนทับ');
        state.cloud.revision = current.revision;
      }
      if (state.cloud.revision !== current.revision) throw new Error('ข้อมูลกลางเปลี่ยนแล้ว กรุณาอ่านข้อมูลล่าสุดก่อนบันทึก');
      const attachments = [...snapshot.works, ...snapshot.awards].flatMap(item => item.attachments || []);
      const uploaded = new Map();
      let done = 0;
      for (const file of attachments) {
        if (!file.driveId) {
          let remote = uploaded.get(file.fileId);
          if (!remote) {
            const local = await getBlob(file.fileId);
            if (!local?.blob) throw new Error(`ไม่พบไฟล์ ${file.name} ในเครื่อง จึงหยุดก่อนบันทึกข้อมูลกลาง`);
            remote = await cloudRequest(`/api/files?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: local.blob });
            uploaded.set(file.fileId, remote);
          }
          file.driveId = remote.driveId;
        }
        done++;
        if ($('#cloudMessage')) $('#cloudMessage').textContent = `เตรียมไฟล์ ${done}/${attachments.length}`;
      }
      const result = await cloudRequest('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: snapshot, revision: state.cloud.revision }) });
      state.cloud.revision = result.revision;
      // Merge only remote file identifiers back; retain edits made during upload.
      const remoteIds = new Map(attachments.map(file => [file.fileId, file.driveId]));
      [...state.works, ...state.awards].forEach(item => (item.attachments || []).forEach(file => { if (remoteIds.has(file.fileId)) file.driveId = remoteIds.get(file.fileId); }));
      saveState();
      state.cloud.message = `บันทึกและอ่านยืนยันจาก Drive สำเร็จ ${new Date().toLocaleTimeString('th-TH')} หากแก้ไขระหว่างอัปโหลด ให้กดบันทึกอีกครั้ง`;
    } catch (error) { state.cloud.message = `ยังไม่บันทึกข้อมูลกลาง: ${error.message} ข้อมูลในเครื่องยังอยู่`; }
    finally { state.cloud.busy = false; renderConnection(); }
  }

  function submitPerson(form) {
    const data = new FormData(form);
    const id = form.dataset.personId || uid('staff');
    const old = state.staff.find(p => p.id === id);
    const name = data.get('name').trim();
    if (!name || state.staff.some(p => p.id !== id && p.name === name)) throw new Error('ชื่อนี้มีอยู่แล้ว หรือยังไม่ได้กรอกชื่อ');
    const lines = key => [...new Set(data.get(key).split('\n').map(t => t.trim()).filter(Boolean))];
    const person = { id, name, position: data.get('position').trim(), role: data.get('role').trim(), primary: lines('primary'), secondary: lines('secondary'), verified: data.has('verified') };
    if (old) {
      state.staff = state.staff.map(p => p.id === id ? person : p);
      state.works.forEach(w => {
        if (w.ownerId === id || (!w.ownerId && w.owner === old.name)) { w.ownerId = id; w.owner = name; }
        if ((w.contributorIds || []).includes(id) || (w.contributors || []).includes(old.name)) w.contributors = [...new Set((w.contributors || []).map(n => n === old.name ? name : n))];
      });
      if (state.profile.staffId === id || state.profile.name === old.name) { state.profile.name = name; state.profile.staffId = id; }
    } else state.staff.push(person);
    saveState(); closeModal(); setView('staff'); showToast('บันทึกทะเบียนบุคลากรแล้ว');
  }

  function closeModal() {
    $('#modalBackdrop').hidden = true;
    $('#modal').innerHTML = '';
    document.body.style.overflow = '';
    state.editingId = null;
    state.editingAwardId = null;
    state.pendingFiles = [];
    state.existingAttachments = [];
  }

  function openWorkForm(id = null) {
    const work = id ? state.works.find((item) => item.id === id) : null;
    state.editingId = id;
    state.pendingFiles = [];
    state.existingAttachments = work ? [...(work.attachments || [])] : [];
    const today = new Date().toISOString().slice(0, 10);
    openModal(`<div class="modal-head"><div><h2 id="modalTitle">${work ? 'แก้ไขผลงาน' : 'เพิ่มผลงานใหม่'}</h2><p>${work ? 'แก้ไขข้อมูลแล้วบันทึกได้ทันที' : 'กรอกข้อมูลสำคัญก่อน แล้วเพิ่มรายละเอียดหรือหลักฐานภายหลังได้'}</p></div><button class="close-button" data-action="close-modal">×</button></div><form class="modal-body" id="workForm"><div class="form-grid"><div class="form-field full"><label>ชื่อผลงาน <em>*</em></label><input name="title" required value="${esc(work?.title || '')}" placeholder="เช่น ระบบติดตามผู้สัมผัสโรค..." /></div><div class="form-field"><label>ประเภทผลงาน <em>*</em></label><select name="type" required>${TYPE_OPTIONS.map((item) => `<option ${item === (work?.type || '') ? 'selected' : ''}>${esc(item)}</option>`).join('')}</select></div><div class="form-field"><label>หมวดงาน</label><select name="category">${CATEGORY_OPTIONS.map((item) => `<option ${item === (work?.category || '') ? 'selected' : ''}>${esc(item)}</option>`).join('')}</select></div><div class="form-field"><label>ปีงบประมาณ <em>*</em></label><select name="year" required>${YEARS.map((item) => `<option value="${item}" ${String(item) === String(work?.year || 2568) ? 'selected' : ''}>${item}</option>`).join('')}</select></div><div class="form-field"><label>วันที่ดำเนินงาน</label><input name="date" type="date" value="${esc(work?.date || today)}" /></div><div class="form-field"><label>ผู้รับผิดชอบหลัก <em>*</em></label><input name="owner" required value="${esc(work?.owner || state.profile.name)}" /></div><div class="form-field full"><label>บทสรุปสั้น</label><textarea name="summary" placeholder="สรุปผลงานให้ผู้บริหารอ่านเข้าใจได้ใน 2–3 บรรทัด">${esc(work?.summary || '')}</textarea></div><div class="form-field full"><label>ผลลัพธ์และประโยชน์</label><textarea name="result" placeholder="เกิดผลลัพธ์อะไร ต่อใคร และมีหลักฐานใดรองรับ">${esc(work?.result || '')}</textarea></div><div class="form-field full"><label>ผู้ร่วมผลงาน</label><input name="contributors" value="${esc((work?.contributors || []).join(', '))}" placeholder="คั่นชื่อด้วยเครื่องหมายจุลภาค" /></div><div class="form-field full"><label>หลักฐาน รูปภาพ และเอกสาร</label><div class="upload-box"><input id="workFilesInput" type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx" /><small>ภาพกิจกรรมจะถูกย่ออัตโนมัติ ส่วนไฟล์สำคัญเก็บต้นฉบับในต้นแบบนี้</small><div class="file-list" id="filePreviewList">${filePreviewMarkup(state.existingAttachments, true)}</div></div></div><div class="form-field full"><label class="check-label"><input name="featured" type="checkbox" ${work?.featured ? 'checked' : ''} /> ทำเครื่องหมายเป็นผลงานเด่น</label></div></div><div class="modal-foot"><button type="button" class="secondary-button" data-action="close-modal">ยกเลิก</button><button type="submit" class="primary-button">บันทึกและเผยแพร่</button></div></form>`);
    const input = $('#workFilesInput');
    if (input) input.addEventListener('change', handlePendingFiles);
  }

  function filePreviewMarkup(files = [], existing = false) {
    if (!files.length) return '<span style="font-size:11px;color:#9aaead">ยังไม่ได้เลือกไฟล์</span>';
    return files.map((file, index) => `<div class="file-item"><span>${file.kind === 'image' || (file.type || '').startsWith('image/') ? '▧' : '▤'}</span><span style="flex:1">${esc(file.name || file.file?.name || 'ไฟล์')}</span><span>${formatBytes(file.size || file.file?.size)}</span>${existing ? `<button type="button" class="small-button" data-action="remove-existing-file" data-index="${index}">ลบ</button>` : ''}</div>`).join('');
  }

  function handlePendingFiles(event) {
    state.pendingFiles = Array.from(event.target.files || []);
    const all = [...state.existingAttachments, ...state.pendingFiles.map((file) => ({ file, name: file.name, type: file.type, size: file.size, kind: file.type.startsWith('image/') ? 'image' : 'document' }))];
    $('#filePreviewList').innerHTML = filePreviewMarkup(all, false);
  }

  function openAwardForm(id = null) {
    const award = id ? state.awards.find((item) => item.id === id) : null;
    state.editingAwardId = id;
    state.pendingFiles = [];
    state.existingAttachments = award ? [...(award.attachments || [])] : [];
    const today = new Date().toISOString().slice(0, 10);
    openModal(`<div class="modal-head"><div><h2 id="modalTitle">${award ? 'แก้ไขรางวัล' : 'เพิ่มรางวัล'}</h2><p>เพิ่มรายละเอียดรางวัลและหลักฐานประกอบได้ทันที</p></div><button class="close-button" data-action="close-modal">×</button></div><form class="modal-body" id="awardForm"><div class="form-grid"><div class="form-field full"><label>ชื่อรางวัล <em>*</em></label><input name="title" required value="${esc(award?.title || '')}" placeholder="เช่น รางวัลหน่วยงานดีเด่น..." /></div><div class="form-field"><label>หน่วยงานผู้มอบ</label><input name="issuer" value="${esc(award?.issuer || '')}" placeholder="ชื่อหน่วยงาน" /></div><div class="form-field"><label>ระดับรางวัล</label><select name="level"><option ${award?.level === 'ระดับประเทศ' ? 'selected' : ''}>ระดับประเทศ</option><option ${award?.level === 'ระดับเขต' ? 'selected' : ''}>ระดับเขต</option><option ${award?.level === 'ระดับจังหวัด' ? 'selected' : ''}>ระดับจังหวัด</option><option ${award?.level === 'หน่วยงาน' ? 'selected' : ''}>หน่วยงาน</option></select></div><div class="form-field"><label>ปีงบประมาณ <em>*</em></label><select name="year" required>${YEARS.map((item) => `<option value="${item}" ${String(item) === String(award?.year || 2568) ? 'selected' : ''}>${item}</option>`).join('')}</select></div><div class="form-field"><label>วันที่ได้รับรางวัล</label><input name="date" type="date" value="${esc(award?.date || today)}" /></div><div class="form-field full"><label>ผู้รับรางวัล</label><input name="recipients" value="${esc(award?.recipients || state.profile.name)}" placeholder="บุคคล ทีม หรือกลุ่มงาน" /></div><div class="form-field full"><label>รายละเอียด</label><textarea name="description" placeholder="รายละเอียดสั้น ๆ ของรางวัล">${esc(award?.description || '')}</textarea></div><div class="form-field full"><label>ผลงานที่เกี่ยวข้อง</label><select name="relatedWorkId"><option value="">ไม่เชื่อมกับผลงาน</option>${publishedWorks().map((work) => `<option value="${esc(work.id)}" ${work.id === award?.relatedWorkId ? 'selected' : ''}>${esc(work.title)}</option>`).join('')}</select></div><div class="form-field full"><label>เกียรติบัตรหรือหลักฐาน</label><div class="upload-box"><input id="awardFilesInput" type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf,.doc,.docx" /><small>ไฟล์จะเก็บในพื้นที่ต้นแบบภายในเครื่องนี้ก่อน</small><div class="file-list" id="filePreviewList">${filePreviewMarkup(state.existingAttachments, true)}</div></div></div></div><div class="modal-foot"><button type="button" class="secondary-button" data-action="close-modal">ยกเลิก</button><button type="submit" class="primary-button">บันทึกและเผยแพร่</button></div></form>`);
    const input = $('#awardFilesInput');
    if (input) input.addEventListener('change', handlePendingFiles);
  }

  async function submitWork(form) {
    const data = new FormData(form);
    const selectedPeople = data.getAll('contributorId').map(id => state.staff.find(p => p.id === id)).filter(Boolean);
    const legacyNames = String(data.get('contributors') || '').split(',').map(n => n.trim()).filter(n => n && !state.staff.some(p => p.name === n));
    data.set('contributors', [...new Set([...selectedPeople.map(p => p.name), ...legacyNames])].join(', '));
    const existing = state.editingId ? state.works.find((item) => item.id === state.editingId) : null;
    const newFiles = await saveFiles(state.pendingFiles);
    const work = { ...(existing || { id: uid('work'), createdAt: nowISO() }), title: data.get('title').trim(), type: data.get('type'), category: data.get('category'), year: Number(data.get('year')), date: data.get('date'), owner: data.get('owner').trim(), contributors: data.get('contributors').split(',').map((item) => item.trim()).filter(Boolean), summary: data.get('summary').trim(), result: data.get('result').trim(), featured: data.get('featured') === 'on', attachments: [...state.existingAttachments, ...newFiles], status: 'published', updatedAt: nowISO() };
    work.ownerId = state.staff.find(p => p.name === work.owner)?.id || '';
    work.contributorIds = selectedPeople.map(p => p.id);
    work.responsibility = data.get('responsibility') || '';
    state.works = existing ? state.works.map((item) => item.id === work.id ? work : item) : [work, ...state.works];
    saveState();
    closeModal();
    showToast(existing ? 'แก้ไขผลงานเรียบร้อยแล้ว' : 'เผยแพร่ผลงานเรียบร้อยแล้ว');
    setView(state.view);
  }

  async function submitAward(form) {
    const data = new FormData(form);
    const existing = state.editingAwardId ? state.awards.find((item) => item.id === state.editingAwardId) : null;
    const newFiles = await saveFiles(state.pendingFiles);
    const relatedWork = state.works.find((item) => item.id === data.get('relatedWorkId'));
    const award = { ...(existing || { id: uid('award'), createdAt: nowISO() }), title: data.get('title').trim(), issuer: data.get('issuer').trim(), level: data.get('level'), year: Number(data.get('year')), date: data.get('date'), recipients: data.get('recipients').trim(), description: data.get('description').trim(), relatedWorkId: data.get('relatedWorkId'), relatedWorkTitle: relatedWork?.title || '', attachments: [...state.existingAttachments, ...newFiles], status: 'published', updatedAt: nowISO() };
    state.awards = existing ? state.awards.map((item) => item.id === award.id ? award : item) : [award, ...state.awards];
    saveState();
    closeModal();
    showToast(existing ? 'แก้ไขรางวัลเรียบร้อยแล้ว' : 'เผยแพร่รางวัลเรียบร้อยแล้ว');
    setView(state.view);
  }

  function openWorkDetail(id) {
    const work = state.works.find((item) => item.id === id);
    if (!work) return;
    const images = (work.attachments || []).filter((file) => file.kind === 'image');
    const docs = (work.attachments || []).filter((file) => file.kind !== 'image');
    openModal(`<div class="modal-head"><div><p class="eyebrow" style="margin:0">${yearLabel(work.year)} · ${esc(work.type || 'ผลงาน')}</p><h2 id="modalTitle">รายละเอียดผลงาน</h2></div><button class="close-button" data-action="close-modal">×</button></div><div class="modal-body"><div class="detail-hero">${images[0] ? `<div class="detail-cover"><img data-file-id="${esc(images[0].fileId)}" alt="${esc(work.title)}" /></div>` : '<div class="detail-cover">✦</div>'}<div><h2>${esc(work.title)}</h2><p class="detail-copy">${esc(work.summary || 'ยังไม่มีบทสรุป')}</p><div class="card-meta" style="justify-content:flex-start;gap:14px;margin-top:12px"><span>${esc(work.owner || 'ไม่ระบุเจ้าของ')}</span><span>${formatDate(work.date)}</span><span class="pill">${esc(work.category || 'ไม่ระบุหมวด')}</span></div></div></div>${work.result ? `<div class="detail-section"><h3>ผลลัพธ์และประโยชน์</h3><p class="detail-copy">${esc(work.result)}</p></div>` : ''}${images.length ? `<div class="detail-section"><h3>ภาพประกอบ <small style="font:400 11px 'Sarabun';color:#91a4a2">${images.length} ภาพ</small></h3><div class="gallery">${images.map((file) => `<div class="gallery-item"><img data-file-id="${esc(file.fileId)}" alt="${esc(file.caption || work.title)}" /></div>`).join('')}</div></div>` : ''}${docs.length ? `<div class="detail-section"><h3>เอกสารและหลักฐาน</h3><div class="document-list">${docs.map((file) => `<a class="document-item" data-download-id="${esc(file.fileId)}" data-file-name="${esc(file.name)}" target="_blank" rel="noopener"><span>▤</span><span style="flex:1">${esc(file.name)}</span><span>${formatBytes(file.size)} ↗</span></a>`).join('')}</div></div>` : ''}<div class="modal-foot"><button class="secondary-button" data-action="edit-work" data-id="${esc(work.id)}">แก้ไขผลงาน</button><button class="danger-button" data-action="trash-work" data-id="${esc(work.id)}">ย้ายลงถังขยะ</button></div></div>`);
    if (work.responsibility || work.contributors?.length) {
      const summary = document.createElement('div');
      summary.className = 'detail-section';
      summary.innerHTML = `<h3>ผู้ร่วมงานและงานรับผิดชอบ</h3><p class="detail-copy">${esc(work.responsibility || 'ไม่ระบุงาน')}<br>ผู้ร่วมงาน: ${esc((work.contributors || []).join(', ') || 'ไม่มี')}</p>`;
      $('.modal-foot', $('#modal')).before(summary);
    }
    hydrateImages($('#modal'));
    hydrateDownloads($('#modal'));
  }

  function openAwardDetail(id) {
    const award = state.awards.find((item) => item.id === id);
    if (!award) return;
    const images = (award.attachments || []).filter((file) => file.kind === 'image');
    const docs = (award.attachments || []).filter((file) => file.kind !== 'image');
    openModal(`<div class="modal-head"><div><p class="eyebrow" style="margin:0">${yearLabel(award.year)} · รางวัล</p><h2 id="modalTitle">รายละเอียดรางวัล</h2></div><button class="close-button" data-action="close-modal">×</button></div><div class="modal-body"><div class="detail-hero">${images[0] ? `<div class="detail-cover"><img data-file-id="${esc(images[0].fileId)}" alt="${esc(award.title)}" /></div>` : '<div class="detail-cover" style="background:var(--gold-soft);color:var(--gold)">🏆</div>'}<div><h2>${esc(award.title)}</h2><p class="detail-copy">${esc(award.description || 'ยังไม่มีรายละเอียด')}</p><div class="card-meta" style="justify-content:flex-start;gap:14px;margin-top:12px"><span>${esc(award.issuer || 'ไม่ระบุหน่วยงานผู้มอบ')}</span><span>${esc(award.recipients || 'ไม่ระบุผู้รับ')}</span><span class="pill gold">${esc(award.level || 'ไม่ระบุระดับ')}</span></div></div></div>${images.length ? `<div class="detail-section"><h3>ภาพและหลักฐาน <small style="font:400 11px 'Sarabun';color:#91a4a2">${images.length} ภาพ</small></h3><div class="gallery">${images.map((file) => `<div class="gallery-item"><img data-file-id="${esc(file.fileId)}" alt="${esc(file.caption || award.title)}" /></div>`).join('')}</div></div>` : ''}${docs.length ? `<div class="detail-section"><h3>เอกสาร</h3><div class="document-list">${docs.map((file) => `<a class="document-item" data-download-id="${esc(file.fileId)}" data-file-name="${esc(file.name)}" target="_blank" rel="noopener"><span>▤</span><span style="flex:1">${esc(file.name)}</span><span>${formatBytes(file.size)} ↗</span></a>`).join('')}</div></div>` : ''}<div class="modal-foot"><button class="secondary-button" data-action="edit-award" data-id="${esc(award.id)}">แก้ไขรางวัล</button><button class="danger-button" data-action="trash-award" data-id="${esc(award.id)}">ย้ายลงถังขยะ</button></div></div>`);
    hydrateImages($('#modal'));
    hydrateDownloads($('#modal'));
  }

  function openProfileForm() {
    openModal(`<div class="modal-head"><div><h2 id="modalTitle">ตั้งค่าผู้ใช้</h2><p>ใช้ระบุชื่อผู้รับผิดชอบในรายการที่เพิ่มจากเครื่องนี้</p></div><button class="close-button" data-action="close-modal">×</button></div><form class="modal-body" id="profileForm"><div class="form-field"><label>ชื่อที่แสดง <em>*</em></label><input name="name" required value="${esc(state.profile.name)}" /></div><div class="form-field" style="margin-top:14px"><label>อีเมล (ถ้ามี)</label><input name="email" type="email" value="${esc(state.profile.email)}" placeholder="ใช้เตรียมเชื่อม Google ในอนาคต" /></div><div class="modal-foot"><button type="button" class="secondary-button" data-action="close-modal">ยกเลิก</button><button type="submit" class="primary-button">บันทึก</button></div></form>`);
  }

  function openHelp() {
    openModal(`<div class="modal-head"><div><h2 id="modalTitle">คำแนะนำการใช้งาน</h2><p>ต้นแบบรุ่นแรกก่อนเชื่อมต่อ Google Drive และ GitHub</p></div><button class="close-button" data-action="close-modal">×</button></div><div class="modal-body"><div class="help-list"><div><strong>เพิ่มผลงาน:</strong> กด “เพิ่มผลงาน” กรอกข้อมูลสำคัญ แนบไฟล์ แล้วกด “บันทึกและเผยแพร่” ข้อมูลจะแสดงในภาพรวมทันที</div><div><strong>พื้นที่จัดเก็บ:</strong> รายละเอียดเก็บในเบราว์เซอร์เครื่องนี้ ไฟล์ภาพและเอกสารเก็บใน IndexedDB ของเบราว์เซอร์ จึงยังไม่แชร์ข้ามเครื่อง</div><div><strong>สำรองข้อมูล:</strong> ใช้ “ส่งออกข้อมูล” เก็บไฟล์ JSON ก่อนเปลี่ยนเครื่อง หรือก่อนเชื่อมต่อระบบจริง</div><div><strong>ขั้นถัดไป:</strong> เปลี่ยนชั้นจัดเก็บเป็น Google Sheets/Drive โดยคงหน้าจอและรูปแบบข้อมูลชุดนี้ไว้</div></div></div>`);
  }

  function openAnnualPrintMenu() {
    const published = publishedWorks();
    openModal(`<div class="modal-head"><div><h2 id="modalTitle">พิมพ์สรุปผลงานแยกรายปี</h2><p>เลือกปีงบประมาณเพื่อเปิดหน้าพิมพ์รายงาน</p></div><button class="close-button" data-action="close-modal">×</button></div><div class="modal-body"><div class="annual-grid">${YEARS.map((year) => { const workCount = published.filter((work) => Number(work.year) === year).length; const awardCount = publishedAwards().filter((award) => Number(award.year) === year).length; return `<button class="year-card ${year === state.annualYear ? 'selected' : ''}" data-action="print-annual" data-year="${year}"><span>${year}</span><small>ปีงบประมาณ</small><strong>${workCount}</strong><small>ผลงาน · ${awardCount} รางวัล</small></button>`; }).join('')}</div><div class="notice">รายงานจะแสดงจำนวนผลงาน รางวัล ผู้มีส่วนร่วม ลำดับเหตุการณ์ และรายการผลงานของปีที่เลือก จากข้อมูลที่เผยแพร่ในเครื่องนี้</div><div class="modal-foot"><button type="button" class="secondary-button" data-action="close-modal">ยกเลิก</button></div></div>`);
  }

  function printAnnualSummary(year) {
    const works = publishedWorks().filter((work) => Number(work.year) === Number(year));
    const awards = publishedAwards().filter((award) => Number(award.year) === Number(year));
    const people = new Set(works.flatMap((work) => [work.owner, ...(work.contributors || [])]).filter(Boolean));
    const timeline = [...works.map((work) => ({ date: work.date, title: work.title, type: work.type || 'ผลงาน' })), ...awards.map((award) => ({ date: award.date, title: award.title, type: 'รางวัล' }))].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const reportDate = new Date().toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' });
    const workRows = works.length ? works.map((work, index) => `<tr><td>${index + 1}</td><td><strong>${esc(work.title)}</strong><br><span>${esc(work.summary || 'ไม่ระบุบทสรุป')}</span></td><td>${esc(work.type || 'ไม่ระบุ')}</td><td>${esc(work.owner || 'ไม่ระบุ')}</td><td>${esc(work.result || 'ไม่ระบุ')}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">ไม่มีผลงานเผยแพร่ในปีนี้</td></tr>';
    const awardRows = awards.length ? awards.map((award, index) => `<tr><td>${index + 1}</td><td><strong>${esc(award.title)}</strong><br><span>${esc(award.description || '')}</span></td><td>${esc(award.issuer || 'ไม่ระบุ')}</td><td>${esc(award.level || 'ไม่ระบุ')}</td><td>${esc(award.recipients || 'ไม่ระบุ')}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">ไม่มีรางวัลเผยแพร่ในปีนี้</td></tr>';
    const timelineRows = timeline.length ? timeline.map((item) => `<tr><td>${formatDate(item.date)}</td><td>${esc(item.type)}</td><td>${esc(item.title)}</td></tr>`).join('') : '<tr><td colspan="3" class="empty">ไม่มีเหตุการณ์ที่บันทึกไว้</td></tr>';
    const existing = $('#printReport');
    if (existing) existing.remove();
    const report = document.createElement('section');
    report.id = 'printReport';
    report.className = 'print-report';
    report.innerHTML = `<div class="print-header"><div><h1>สรุปผลงานกลุ่มงานควบคุมโรคติดต่อ</h1><p>ปีงบประมาณ ${year}</p></div><div class="print-meta">จัดทำเมื่อ ${reportDate}<br>ข้อมูลจากรายการที่เผยแพร่</div></div><div class="print-stats"><div><b>${works.length}</b><span>ผลงานเผยแพร่</span></div><div><b>${awards.length}</b><span>รางวัล</span></div><div><b>${people.size}</b><span>ผู้มีส่วนร่วม</span></div></div><h2>ผลงานประจำปี ${year}</h2><table><thead><tr><th style="width:6%">ลำดับ</th><th style="width:29%">ชื่อผลงาน / บทสรุป</th><th style="width:15%">ประเภท</th><th style="width:18%">ผู้รับผิดชอบ</th><th>ผลลัพธ์และประโยชน์</th></tr></thead><tbody>${workRows}</tbody></table><h2>รางวัลประจำปี ${year}</h2><table><thead><tr><th style="width:6%">ลำดับ</th><th>ชื่อรางวัล / รายละเอียด</th><th>หน่วยงานผู้มอบ</th><th>ระดับ</th><th>ผู้รับ</th></tr></thead><tbody>${awardRows}</tbody></table><h2>ลำดับเหตุการณ์</h2><table><thead><tr><th style="width:22%">วันที่</th><th style="width:18%">ประเภท</th><th>รายการ</th></tr></thead><tbody>${timelineRows}</tbody></table><div class="print-footer">หมายเหตุ: รายงานนี้จัดทำจากข้อมูลที่ผู้ใช้เผยแพร่ในระบบต้นแบบ ข้อมูลสามารถเปลี่ยนแปลงได้เมื่อมีการแก้ไขรายการ</div>`;
    document.body.appendChild(report);
    closeModal();
    window.addEventListener('afterprint', () => report.remove(), { once: true });
    setTimeout(() => window.print(), 80);
  }

  function trashItem(type, id) {
    const list = type === 'work' ? state.works : state.awards;
    const item = list.find((entry) => entry.id === id);
    if (!item || !window.confirm(`ย้าย “${item.title}” ลงถังขยะหรือไม่?`)) return;
    item.status = 'trashed';
    item.updatedAt = nowISO();
    saveState();
    closeModal();
    showToast('ย้ายรายการลงถังขยะแล้ว');
    setView(state.view);
  }

  function exportData() {
    const payload = { exportedAt: nowISO(), format: 'reward-archive-prototype-v1', profile: state.profile, staff: state.staff, works: state.works, awards: state.awards, note: 'ไฟล์แนบอยู่ใน IndexedDB ของเครื่องต้นทางหรือ Google Drive ที่เชื่อมแล้ว JSON นี้ไม่รวมเนื้อไฟล์แนบ' };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `คลังผลงาน-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('ส่งออกข้อมูลแล้ว');
  }

  async function importData(file) {
    try {
      const payload = JSON.parse(await file.text());
      if (!Array.isArray(payload.works) || !Array.isArray(payload.awards)) throw new Error('รูปแบบไฟล์ไม่ถูกต้อง');
      state.works = payload.works;
      state.awards = payload.awards;
      state.profile = { ...DEFAULT_PROFILE, ...(payload.profile || {}) };
      if (Array.isArray(payload.staff)) state.staff = payload.staff;
      saveState();
      showToast('นำเข้าข้อมูลแล้ว');
      setView(state.view);
    } catch (error) {
      showToast(`นำเข้าไม่สำเร็จ: ${error.message}`);
    }
  }

  function updateSearch(value) {
    const focusedId = document.activeElement?.id;
    const cursor = document.activeElement?.selectionStart;
    state.search = value;
    if (state.view === 'works') renderWorks();
    if (state.view === 'awards') renderAwards();
    if (state.view === 'staff') renderStaff();
    if (focusedId && document.getElementById(focusedId)) {
      const target = document.getElementById(focusedId); target.focus();
      if (typeof cursor === 'number' && target.type !== 'search') target.setSelectionRange(cursor, cursor);
    }
  }

  document.addEventListener('click', (event) => {
    const nav = event.target.closest('[data-view]');
    if (nav) { setView(nav.dataset.view); return; }
    const actionElement = event.target.closest('[data-action]');
    if (!actionElement) return;
    const action = actionElement.dataset.action;
    if (action === 'add-work') openWorkForm();
    else if (action === 'add-award') openAwardForm();
    else if (action === 'edit-work') { const id = actionElement.dataset.id; closeModal(); openWorkForm(id); }
    else if (action === 'edit-award') { const id = actionElement.dataset.id; closeModal(); openAwardForm(id); }
    else if (action === 'view-work') openWorkDetail(actionElement.dataset.id);
    else if (action === 'view-award') openAwardDetail(actionElement.dataset.id);
    else if (action === 'trash-work') trashItem('work', actionElement.dataset.id);
    else if (action === 'trash-award') trashItem('award', actionElement.dataset.id);
    else if (action === 'close-modal') closeModal();
    else if (action === 'select-year') { state.annualYear = Number(actionElement.dataset.year); renderAnnual(); }
    else if (action === 'export-report') exportData();
    else if (action === 'print-annual') printAnnualSummary(Number(actionElement.dataset.year));
    else if (action === 'print-current-annual') printAnnualSummary(state.annualYear);
    else if (action === 'add-person') openPersonForm();
    else if (action === 'edit-person') openPersonForm(actionElement.dataset.id);
    else if (action === 'person-works') { state.staffFilter = actionElement.dataset.id; state.search = ''; state.workYear = state.workType = state.workCategory = 'all'; $('#globalSearch').value = ''; setView('works'); }
    else if (action === 'clear-person-filter') { state.staffFilter = 'all'; renderWorks(); }
    else if (action === 'connect-google') connectGoogle();
    else if (action === 'cloud-save') saveCloud();
    else if (action === 'cloud-load') loadCloud();
    else if (action === 'restore-before-cloud') {
      const backup = localStorage.getItem(`${META_KEY}-before-cloud`);
      if (backup) { const data = JSON.parse(backup); state.works = data.works; state.awards = data.awards; state.staff = data.staff; state.cloud.revision = null; saveState(); showToast('คืนข้อมูลในเครื่องแล้ว'); }
      else showToast('ยังไม่มีข้อมูลสำรองก่อนอ่าน Drive');
    }
    else if (action === 'remove-existing-file') { state.existingAttachments.splice(Number(actionElement.dataset.index), 1); $('#filePreviewList').innerHTML = filePreviewMarkup(state.existingAttachments, true); }
  });

  document.addEventListener('change', (event) => {
    if (event.target.name === 'owner' && $('#ownerResponsibilities')) {
      const person = state.staff.find(p => p.name === event.target.value);
      $('#ownerResponsibilities').textContent = person ? `งานหลัก: ${person.primary.join(' / ')}` : '';
      if (person && $('#responsibilitySelect') && !$('#responsibilitySelect').value) $('#responsibilitySelect').value = person.primary[0] || '';
    }
    if (event.target.id === 'workYearFilter') { state.workYear = event.target.value; renderWorks(); }
    if (event.target.id === 'workTypeFilter') { state.workType = event.target.value; renderWorks(); }
    if (event.target.id === 'workCategoryFilter') { state.workCategory = event.target.value; renderWorks(); }
    if (event.target.id === 'awardYearFilter') { state.awardYear = event.target.value; renderAwards(); }
  });

  document.addEventListener('input', (event) => {
    if (event.target.id === 'globalSearch') updateSearch(event.target.value);
    if (event.target.id === 'worksSearch' || event.target.id === 'awardSearch') updateSearch(event.target.value);
  });

  document.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (event.target.id === 'personForm') {
      try { submitPerson(event.target); } catch (error) { showToast(error.message); }
      return;
    }
    if (event.target.id === 'workForm' || event.target.id === 'awardForm') {
      const form = event.target;
      if (form.dataset.saving) return;
      form.dataset.saving = 'true';
      const button = $('[type="submit"]', form); if (button) button.disabled = true;
      try { if (form.id === 'workForm') await submitWork(form); else await submitAward(form); }
      catch { showToast('บันทึกไม่สำเร็จ โปรดตรวจพื้นที่ในเครื่องและลองใหม่ ข้อมูลในฟอร์มยังอยู่'); }
      finally { delete form.dataset.saving; if (button) button.disabled = false; }
      return;
    }
    if (event.target.id === 'profileForm') {
      const data = new FormData(event.target);
      state.profile.name = data.get('name').trim() || DEFAULT_PROFILE.name;
      state.profile.staffId = state.staff.find(p => p.name === state.profile.name)?.id || '';
      state.profile.email = data.get('email').trim();
      saveState();
      closeModal();
      showToast('บันทึกข้อมูลผู้ใช้แล้ว');
      setView(state.view);
    }
  });

  $('#modalBackdrop').addEventListener('click', (event) => { if (event.target.id === 'modalBackdrop') closeModal(); });
  $('#helpBtn').addEventListener('click', openHelp);
  $('#profileBtn').addEventListener('click', openProfileForm);
  $('#profileChip').addEventListener('click', openProfileForm);
  $('#exportBtn').addEventListener('click', exportData);
  $('#printAnnualBtn').addEventListener('click', openAnnualPrintMenu);
  $('#importInput').addEventListener('change', (event) => { if (event.target.files[0]) importData(event.target.files[0]); event.target.value = ''; });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#modalBackdrop').hidden) closeModal(); });

  loadState();
  updateProfileUI();
  updateStorageUI();
  setView(location.hash === '#connection' ? 'connection' : 'overview');
  if (location.protocol !== 'file:' && state.view !== 'connection') {
    cloudRequest('/api/status').then(status => { Object.assign(state.cloud, status); if (status.connected) setView(state.view); }).catch(() => {});
  }
})();
