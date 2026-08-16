/* ---------------- state ---------------- */
const drugs = []; // {id, input, status, genericName, className, label, flags:Map(flagId -> {snippet}), colorClass }
let flagIndex = new Map(); // flagId -> {flag, drugNames:[], snippet}
let answers = {};

const DRUG_PALETTE = ['teal','violet','orange','pink'];

// These flags describe something about a specific medication (when/how you
// take THAT drug), not a general personal habit — so unlike the others,
// they must never be merged across multiple drugs that share the flag.
const PER_DRUG_FLAGS = new Set(['CIRCADIAN','FOOD_TIMING','DAIRY_CALCIUM']);

const FLAG_ICON = {
  SEDATING:'🚗', CAFFEINE:'☕', FOOD_TIMING:'🍽️', GRAPEFRUIT:'🍊', ALCOHOL:'🍷',
  CIRCADIAN:'⏰', PHOTOSENSITIVITY:'☀️', HYDRATION:'💧', SMOKING:'🚬',
  PREGNANCY:'🤰', ORTHOSTATIC:'💫', DAIRY_CALCIUM:'🥛',
};

/* ---------------- flag rules ---------------- */
const FLAG_RULES = [
  { id:'SEDATING', test:/drowsi|somnolen|sedat|dizz|impair(ed|s)? (mental|physical|ability)|do not drive|operate (heavy )?machinery/i,
    label:'Sedation risk', category:'Activity restrictions' },
  { id:'CAFFEINE', test:/caffeine|cns stimulation|central nervous system stimulant/i,
    label:'Caffeine sensitivity', category:'Substance interactions' },
  { id:'FOOD_TIMING', test:/with food|without food|empty stomach|high-fat meal|take with meals|on an empty stomach/i,
    label:'Food timing', category:'Timing rules' },
  { id:'GRAPEFRUIT', test:/grapefruit/i,
    label:'Grapefruit interaction', category:'Substance interactions' },
  { id:'ALCOHOL', test:/\balcohol\b/i,
    label:'Alcohol interaction', category:'Substance interactions' },
  { id:'CIRCADIAN', test:/\b(morning|evening|bedtime|at night|nighttime)\b/i,
    label:'Time-of-day dosing', category:'Timing rules' },
  { id:'PHOTOSENSITIVITY', test:/photosensitiv|sun exposure|sunlight exposure/i,
    label:'Sun sensitivity', category:'Activity restrictions' },
  { id:'HYDRATION', test:/dehydrat|adequate fluid|drink plenty of fluids|maintain hydration/i,
    label:'Hydration need', category:'Activity restrictions' },
  { id:'SMOKING', test:/\bsmoking\b|\btobacco\b|\bcigarette/i,
    label:'Smoking interaction', category:'Substance interactions' },
  { id:'PREGNANCY', test:/pregnan|breast.?feed|nursing mother|lactation/i,
    label:'Pregnancy & breastfeeding', category:'Health considerations' },
  { id:'ORTHOSTATIC', test:/orthostatic|postural hypotension|rising (rapidly|quickly) from a (sitting|lying)|standing up (quickly|rapidly|too fast)/i,
    label:'Dizziness on standing', category:'Activity restrictions' },
  { id:'DAIRY_CALCIUM', test:/\bdairy\b|calcium.?(containing|fortified|supplement)|milk products|do not take with milk/i,
    label:'Dairy & calcium interaction', category:'Substance interactions' },
];

const LABEL_FIELDS = ['dosage_and_administration','warnings','warnings_and_cautions','boxed_warning',
  'drug_interactions','food_interaction','precautions','warnings_and_precautions',
  'pregnancy','nursing_mothers','use_in_specific_populations','teratogenic_effects'];

/* ---------------- question bank ---------------- */
const QUESTIONS = {
  SEDATING: { text:'Do you drive or operate machinery during the day?', type:'choice', options:['Yes, regularly','Occasionally','No'] },
  CAFFEINE: { text:'How much caffeine do you typically have per day?', type:'choice', options:['None','1–2 cups','3 or more cups'] },
  FOOD_TIMING: { text:'Do you usually take this before or after eating?', type:'choice', options:['Before eating','After eating','On an empty stomach','It varies'] },
  GRAPEFRUIT: { text:'Do you eat grapefruit or drink grapefruit juice regularly?', type:'choice', options:['Yes','No'] },
  ALCOHOL: { text:'How often do you drink alcohol?', type:'choice', options:['Never','Occasionally','Regularly'] },
  CIRCADIAN: { text:'What time do you currently take this?', type:'choice', options:['Morning','Afternoon','Evening','Night / before bed'] },
  PHOTOSENSITIVITY: { text:'Do you spend a lot of time in the sun without protection?', type:'choice', options:['Yes','No'] },
  HYDRATION: { text:'Do you usually drink at least 6–8 glasses of water a day?', type:'choice', options:['Yes','No'] },
  SMOKING: { text:'Do you currently smoke or use tobacco?', type:'choice', options:['Yes','No, but I used to','No, never'] },
  PREGNANCY: { text:'Are you currently pregnant, breastfeeding, or planning a pregnancy?', type:'choice', options:['Yes','No','Prefer not to say'] },
  ORTHOSTATIC: { text:'Do you ever feel dizzy or lightheaded when you stand up quickly?', type:'choice', options:['Yes, often','Sometimes','Rarely or never'] },
  DAIRY_CALCIUM: { text:'Do you usually take this around the same time as dairy or a calcium supplement?', type:'choice', options:['Yes','No','Not sure'] },
};

/* ---------------- API calls ---------------- */
const CATEGORY_CLASS = {
  'Timing rules': 'cat-teal',
  'Substance interactions': 'cat-violet',
  'Activity restrictions': 'cat-orange',
  'Health considerations': 'cat-pink',
};

async function resolveRxNorm(name){
  const url = `https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=${encodeURIComponent(name)}&maxEntries=1`;
  const res = await fetch(url);
  if(!res.ok) throw new Error(`RxNorm lookup failed (HTTP ${res.status})`);
  const data = await res.json();
  const candidate = data?.approximateGroup?.candidate?.[0];
  if(!candidate) throw new Error('No RxNorm match for this name');
  const rxcui = candidate.rxcui;

  // resolve to generic ingredient name
  let genericName = null;
  try{
    const relRes = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/related.json?tty=IN+PIN`);
    const relData = await relRes.json();
    const groups = relData?.relatedGroup?.conceptGroup || [];
    for(const g of groups){
      if(g.conceptProperties?.length){ genericName = g.conceptProperties[0].name; break; }
    }
  }catch(e){ console.warn('RxNorm related-name lookup failed:', e); }

  // resolve drug class (best-effort, non-fatal)
  let className = null;
  try{
    const clsRes = await fetch(`https://rxnav.nlm.nih.gov/REST/rxclass/class/byRxcui.json?rxcui=${rxcui}&relaSource=ATC`);
    const clsData = await clsRes.json();
    const item = clsData?.rxclassDrugInfoList?.rxclassDrugInfo?.[0];
    if(item) className = item.rxclassMinConceptItem?.className || null;
  }catch(e){ console.warn('RxClass lookup failed:', e); }

  return { rxcui, genericName: genericName || candidate.name, className };
}

async function fetchOpenFDALabel(rxcui, genericName, originalName){
  const attempts = [
    `openfda.rxcui:"${rxcui}"`,
    `openfda.generic_name:"${genericName}"`,
    `openfda.generic_name:${genericName}`,
    `openfda.substance_name:"${genericName}"`,
    `openfda.substance_name:${genericName}`,
    `openfda.brand_name:"${originalName}"`,
    `openfda.brand_name:${originalName}`,
  ];
  for(const q of attempts){
    try{
      const url = `https://api.fda.gov/drug/label.json?search=${encodeURIComponent(q)}&limit=1`;
      const res = await fetch(url);
      if(!res.ok) continue;
      const data = await res.json();
      if(data.results && data.results.length) return data.results[0];
    }catch(e){ console.warn(`openFDA lookup failed for query "${q}":`, e); }
  }
  return null;
}

function extractFlags(labelResult){
  const found = new Map(); // flagId -> snippet
  if(!labelResult) return found;
  for(const field of LABEL_FIELDS){
    const val = labelResult[field];
    if(!val) continue;
    const text = Array.isArray(val) ? val.join(' ') : String(val);
    for(const rule of FLAG_RULES){
      if(found.has(rule.id)) continue;
      const m = text.match(rule.test);
      if(m){
        const idx = Math.max(0, m.index - 40);
        const snippet = text.slice(idx, idx + 140).trim();
        found.set(rule.id, snippet);
      }
    }
  }
  return found;
}

/* ---------------- UI: step 1 ---------------- */
const drugInput = document.getElementById('drugInput');
const addBtn = document.getElementById('addBtn');
const drugList = document.getElementById('drugList');
const continueBtn = document.getElementById('continueBtn');
const helperText = document.getElementById('helperText');

addBtn.addEventListener('click', addDrug);
drugInput.addEventListener('keydown', e => { if(e.key === 'Enter') addDrug(); });

async function addDrug(){
  const name = drugInput.value.trim();
  if(!name) return;
  drugInput.value = '';
  const id = 'd' + Date.now() + Math.random().toString(36).slice(2,6);
  const colorClass = DRUG_PALETTE[drugs.length % DRUG_PALETTE.length];
  const entry = { id, input:name, status:'pending', genericName:null, className:null, label:null, flags:new Map(), colorClass };
  drugs.push(entry);
  renderDrugList();
  updateContinueState();

  try{
    const { rxcui, genericName, className } = await resolveRxNorm(name);
    entry.genericName = genericName;
    entry.className = className;
    const label = await fetchOpenFDALabel(rxcui, genericName, name);
    entry.label = label;
    entry.flags = extractFlags(label);
    entry.status = label ? 'ok' : 'ok-nolabel';
  }catch(err){
    entry.status = 'err';
    entry.error = err.message;
    console.error(`Lookup failed for "${name}":`, err);
  }
  renderDrugList();
  updateContinueState();
}

function removeDrug(id){
  const idx = drugs.findIndex(d => d.id === id);
  if(idx > -1) drugs.splice(idx, 1);
  renderDrugList();
  updateContinueState();
}

function renderDrugList(){
  drugList.innerHTML = '';
  for(const d of drugs){
    const tag = document.createElement('div');
    tag.className = 'drug-tag';
    const dotClass = d.status === 'pending' ? 'pending' : (d.status === 'err' ? 'err' : 'ok');
    const initial = (d.input || '?').trim().charAt(0).toUpperCase();
    const meta = d.status === 'pending' ? 'looking up…'
      : d.status === 'err' ? (d.error || 'not found — will be skipped')
      : d.status === 'ok-nolabel' ? `${d.className || d.genericName || 'resolved'} · no US FDA label on file`
      : [d.genericName, d.className].filter(Boolean).join(' · ') || 'resolved';
    tag.innerHTML = `
      <span class="avatar-wrap">
        <span class="avatar av-${d.colorClass}">${escapeHtml(initial)}</span>
        <span class="status-dot ${dotClass}"></span>
      </span>
      <span class="info">
        <div class="name">${escapeHtml(d.input)}</div>
        <div class="meta">${escapeHtml(meta)}</div>
      </span>
      <button class="remove" aria-label="Remove ${escapeHtml(d.input)}">×</button>
    `;
    tag.querySelector('.remove').addEventListener('click', () => removeDrug(d.id));
    drugList.appendChild(tag);
  }
}

function updateContinueState(){
  const anyPending = drugs.some(d => d.status === 'pending');
  const anyResolved = drugs.some(d => d.status === 'ok' || d.status === 'ok-nolabel');
  continueBtn.disabled = anyPending || !anyResolved;
  helperText.textContent = anyPending ? 'Looking up your medication…' : 'Add one at a time — we\'ll look each one up as you go.';
}

/* ---------------- UI: step 2 ---------------- */
const step1 = document.getElementById('step1');
const step2 = document.getElementById('step2');
const step3 = document.getElementById('step3');
const questionList = document.getElementById('questionList');
const qHelper = document.getElementById('qHelper');
const getAdviceBtn = document.getElementById('getAdviceBtn');
const restartBtn = document.getElementById('restartBtn');

continueBtn.addEventListener('click', () => {
  buildFlagIndex();
  if(flagIndex.size === 0){
    step2.style.display = 'block';
    qHelper.textContent = 'No specific lifestyle flags were found in the label data for your medications. You can still get general advice below.';
    getAdviceBtn.style.display = 'inline-block';
    questionList.innerHTML = '';
  } else {
    renderQuestions();
    step2.style.display = 'block';
  }
  step1.style.display = 'none';
  window.scrollTo({top:0, behavior:'smooth'});
});

function buildFlagIndex(){
  flagIndex = new Map();
  for(const d of drugs){
    if(d.status === 'err') continue;
    const drugKey = d.genericName || d.input;
    for(const [flagId, snippet] of d.flags.entries()){
      const mapKey = PER_DRUG_FLAGS.has(flagId) ? `${flagId}::${drugKey}` : flagId;
      if(!flagIndex.has(mapKey)) flagIndex.set(mapKey, { flagId, drugNames:[], snippet });
      flagIndex.get(mapKey).drugNames.push(drugKey);
    }
  }
}

function renderQuestions(){
  questionList.innerHTML = '';
  qHelper.textContent = `We found ${flagIndex.size} thing${flagIndex.size===1?'':'s'} worth checking, based on your medications' labels.`;

  const eligibleDrugs = drugs.filter(d => d.status === 'ok' || d.status === 'ok-nolabel');
  for(const d of eligibleDrugs){
    const key = d.genericName || d.input;
    const ownFlags = [...flagIndex.entries()].filter(([, info]) => info.drugNames[0] === key);

    const divider = document.createElement('div');
    divider.className = 'category-divider';
    const dInitial = (d.input || '?').trim().charAt(0).toUpperCase();
    divider.innerHTML = `<span class="avatar av-${d.colorClass} divider-avatar">${escapeHtml(dInitial)}</span>${escapeHtml(d.genericName || d.input)}${d.className ? ` <span class="dv-class">· ${escapeHtml(d.className)}</span>` : ''}`;
    questionList.appendChild(divider);

    if(!ownFlags.length){
      const p = document.createElement('p');
      p.className = 'helper';
      p.textContent = 'No additional questions needed for this medication.';
      questionList.appendChild(p);
      continue;
    }

    for(const [mapKey, info] of ownFlags){
      const flagId = info.flagId;
      const rule = FLAG_RULES.find(r => r.id === flagId);
      const q = QUESTIONS[flagId];
      if(!q) continue;
      const sharedNote = info.drugNames.length > 1 ? `Also applies to ${info.drugNames.slice(1).join(', ')}` : '';
      const card = document.createElement('div');
      card.className = 'q-card ' + (CATEGORY_CLASS[rule.category] || 'cat-teal');
      card.dataset.flag = mapKey;
      card.innerHTML = `
        <div class="r-meta"><span class="r-cat">${escapeHtml(rule.category)}</span></div>
        <div class="q-text">${FLAG_ICON[flagId] || '💊'} ${escapeHtml(q.text)}</div>
        ${sharedNote ? `<div class="q-shared">${escapeHtml(sharedNote)}</div>` : ''}
        <div class="options"></div>
        <div class="q-error">Please choose an answer.</div>
      `;
      const optWrap = card.querySelector('.options');
      for(const opt of q.options){
        const btn = document.createElement('div');
        btn.className = 'opt';
        btn.textContent = opt;
        btn.addEventListener('click', () => {
          optWrap.querySelectorAll('.opt').forEach(o => o.classList.remove('selected'));
          btn.classList.add('selected');
          answers[mapKey] = opt;
          card.querySelector('.q-error').style.display = 'none';
        });
        optWrap.appendChild(btn);
      }
      questionList.appendChild(card);
    }
  }
  getAdviceBtn.style.display = 'inline-block';
}

getAdviceBtn.addEventListener('click', () => {
  const cards = questionList.querySelectorAll('.q-card');
  let valid = true;
  for(const card of cards){
    const flagId = card.dataset.flag;
    if(!answers[flagId]){
      card.querySelector('.q-error').style.display = 'block';
      valid = false;
    }
  }
  if(!valid) return;
  renderResults();
  step2.style.display = 'none';
  step3.style.display = 'block';
  window.scrollTo({top:0, behavior:'smooth'});
});

/* ---------------- advice engine ---------------- */
function buildAdvice(){
  const results = []; // {category, title, body, severity}

  for(const [mapKey, info] of flagIndex.entries()){
    const flagId = info.flagId;
    const rule = FLAG_RULES.find(r => r.id === flagId);
    const answer = answers[mapKey];
    const drugList = info.drugNames.join(', ');

    if(flagId === 'SEDATING'){
      if(answer === 'Yes, regularly'){
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Sedation + daytime driving', severity:'danger',
          body:`${drugList} can cause drowsiness. Since you drive or operate machinery regularly, consider asking your doctor about taking this at night, and avoid driving until you know how it affects you.`, correction:true });
      } else {
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Sedation risk', severity:'ok',
          body:`${drugList} may cause drowsiness. Since you don't regularly drive during the day, this is lower risk for you — just avoid driving in the hours right after your dose.` });
      }
    }

    if(flagId === 'CAFFEINE'){
      if(answer === '3 or more cups'){
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'High caffeine + stimulant interaction', severity:'warn',
          body:`${drugList} interacts with caffeine, and you're taking in a high amount daily. Consider cutting back to 1–2 cups and keeping it earlier in the day to reduce jitteriness or sleep disruption.`, correction:true });
      } else {
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Caffeine sensitivity', severity:'ok',
          body:`${drugList} interacts with caffeine, but your current intake (${answer.toLowerCase()}) is a reasonable level. Keep an eye on it if you notice jitteriness or trouble sleeping.` });
      }
    }

    if(flagId === 'FOOD_TIMING'){
      const wantsEmpty = /empty stomach/i.test(info.snippet);
      const wantsFood = /with food|with meals|high-fat meal/i.test(info.snippet);
      let mismatch = false;
      if(wantsEmpty && answer !== 'On an empty stomach') mismatch = true;
      if(wantsFood && answer === 'On an empty stomach') mismatch = true;
      if(mismatch){
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Food timing mismatch', severity:'warn',
          body:`${drugList}'s label suggests ${wantsEmpty ? 'taking it on an empty stomach' : 'taking it with food'}, but you said you take it "${answer.toLowerCase()}." Adjusting this can improve how well it works or reduce stomach upset.`, correction:true });
      } else {
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Food timing', severity:'ok',
          body:`${drugList} — your current timing ("${answer.toLowerCase()}") lines up with the label guidance. Keep it consistent day to day.` });
      }
    }

    if(flagId === 'GRAPEFRUIT'){
      if(answer === 'Yes'){
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Grapefruit interaction', severity:'danger',
          body:`${drugList} can interact with grapefruit — it can change how much of the drug enters your bloodstream. Consider cutting grapefruit and grapefruit juice out while taking this.`, correction:true });
      } else {
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Grapefruit interaction', severity:'ok',
          body:`${drugList} can interact with grapefruit, but since you don't eat/drink it, this isn't a concern for you right now.` });
      }
    }

    if(flagId === 'ALCOHOL'){
      if(answer !== 'Never'){
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Alcohol interaction', severity: answer === 'Regularly' ? 'danger' : 'warn',
          body:`${drugList} interacts with alcohol. Since you drink ${answer.toLowerCase()}, talk to your doctor or pharmacist about a safe gap between drinking and your dose — combining them can increase side effects like drowsiness or stomach irritation.`, correction:true });
      } else {
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Alcohol interaction', severity:'ok',
          body:`${drugList} interacts with alcohol, but since you don't drink, this isn't a concern for you.` });
      }
    }

    if(flagId === 'CIRCADIAN'){
      const wantsMorning = /morning/i.test(info.snippet);
      const wantsEvening = /evening|bedtime|at night|nighttime/i.test(info.snippet);
      const userMorning = answer === 'Morning' || answer === 'Afternoon';
      const userEvening = answer === 'Evening' || answer === 'Night / before bed';
      let mismatch = (wantsMorning && userEvening) || (wantsEvening && userMorning);
      if(mismatch){
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Time-of-day mismatch', severity:'warn',
          body:`${drugList}'s label points to ${wantsMorning ? 'morning' : 'evening'} dosing, but you're taking it in the ${answer.toLowerCase()}. Ask your pharmacist whether shifting your dosing time could help it work better for you.`, correction:true });
      } else {
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Time-of-day dosing', severity:'ok',
          body:`${drugList} — taking it in the ${answer.toLowerCase()} lines up with the label guidance.` });
      }
    }

    if(flagId === 'PHOTOSENSITIVITY'){
      if(answer === 'Yes'){
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Sun sensitivity', severity:'warn',
          body:`${drugList} can increase sun sensitivity. Since you spend a lot of unprotected time outdoors, use sunscreen and consider covering up more than usual while on this medication.`, correction:true });
      } else {
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Sun sensitivity', severity:'ok',
          body:`${drugList} can increase sun sensitivity, but your current sun exposure habits keep this low risk.` });
      }
    }

    if(flagId === 'HYDRATION'){
      if(answer === 'No'){
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Hydration', severity:'warn',
          body:`${drugList}'s label emphasizes staying hydrated. Try to build in regular water intake through the day, especially around your dose.`, correction:true });
      } else {
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Hydration', severity:'ok',
          body:`${drugList} — your current water intake supports this medication working as intended.` });
      }
    }

    if(flagId === 'SMOKING'){
      if(answer === 'Yes'){
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Smoking interaction', severity:'warn',
          body:`${drugList} can be metabolized differently in smokers, which may change how strong or how long its effects last. Mention that you smoke to your doctor or pharmacist — the dose that works for a non-smoker may not be right for you.`, correction:true });
      } else {
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Smoking interaction', severity:'ok',
          body:`${drugList} can interact with smoking, but since you don't currently smoke, this isn't a concern for you right now.` });
      }
    }

    if(flagId === 'PREGNANCY'){
      if(answer === 'Yes'){
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Pregnancy & breastfeeding', severity:'danger',
          body:`${drugList}'s label includes specific guidance for pregnancy or breastfeeding. Talk to your doctor as soon as possible to confirm this medication is still the right choice for you right now.`, correction:true });
      } else if(answer === 'No'){
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Pregnancy & breastfeeding', severity:'ok',
          body:`${drugList}'s label includes pregnancy/breastfeeding guidance, but this doesn't apply to your situation right now.` });
      } else {
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Pregnancy & breastfeeding', severity:'warn',
          body:`${drugList}'s label includes specific guidance for pregnancy or breastfeeding. If this could apply to you, it's worth checking with your doctor directly.` });
      }
    }

    if(flagId === 'ORTHOSTATIC'){
      if(answer === 'Yes, often'){
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Dizziness on standing', severity:'danger',
          body:`${drugList} can cause a drop in blood pressure when you stand up. Since this already happens to you often, get up slowly from sitting or lying down, and mention this to your doctor — it can raise fall risk.`, correction:true });
      } else if(answer === 'Sometimes'){
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Dizziness on standing', severity:'warn',
          body:`${drugList} can cause dizziness when standing up quickly. Try rising slowly, especially first thing in the morning or after sitting for a while.`, correction:true });
      } else {
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Dizziness on standing', severity:'ok',
          body:`${drugList} can cause dizziness when standing up quickly, but you haven't noticed this so far. Still worth standing up a bit slower until you know how it affects you.` });
      }
    }

    if(flagId === 'DAIRY_CALCIUM'){
      if(answer === 'Yes'){
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Dairy & calcium interaction', severity:'warn',
          body:`${drugList} can bind to calcium in dairy or supplements, which lowers how much of the drug your body actually absorbs. Try spacing it at least 2 hours apart from dairy products or calcium supplements.`, correction:true });
      } else {
        results.push({ category:rule.category, drugNames:info.drugNames, flagId, title:'Dairy & calcium interaction', severity:'ok',
          body:`${drugList} can interact with dairy or calcium, but since you're not taking them close together, this isn't currently a concern.` });
      }
    }
  }

  // cross-drug: multiple sedating/alcohol-interacting drugs stack
  const sedatingDrugs = drugs.filter(d => d.flags.has('SEDATING')).map(d => d.genericName || d.input);
  if(sedatingDrugs.length > 1){
    results.push({ category:'Substance interactions', drugNames:sedatingDrugs, flagId:'SEDATING', title:'Combined sedation across medications', severity:'danger',
      body:`${sedatingDrugs.join(' and ')} can each cause drowsiness on their own — taken together the effect may be stronger than either label suggests alone. Be extra cautious about driving and mention this combination to your doctor.`, correction:true });
  }

  return results;
}

function renderResults(){
  const results = buildAdvice();
  const resultList = document.getElementById('resultList');
  resultList.innerHTML = '';

  const eligibleDrugs = drugs.filter(d => d.status === 'ok' || d.status === 'ok-nolabel');
  for(const d of eligibleDrugs){
    const key = d.genericName || d.input;
    const items = results.filter(r => r.drugNames && r.drugNames.includes(key));

    const divider = document.createElement('div');
    divider.className = 'category-divider';
    const dInitial = (d.input || '?').trim().charAt(0).toUpperCase();
    divider.innerHTML = `<span class="avatar av-${d.colorClass} divider-avatar">${escapeHtml(dInitial)}</span>${escapeHtml(d.genericName || d.input)}${d.className ? ` <span class="dv-class">· ${escapeHtml(d.className)}</span>` : ''}`;
    resultList.appendChild(divider);

    if(!items.length){
      const p = document.createElement('p');
      p.className = 'helper';
      p.textContent = 'No specific lifestyle flags found in the label data for this medication.';
      resultList.appendChild(p);
      continue;
    }

    for(const item of items){
      const card = document.createElement('div');
      card.className = 'result-card' + (item.severity === 'danger' ? ' danger' : item.severity === 'warn' ? ' warn' : '');
      card.innerHTML = `
        <div class="r-meta">
          <span class="r-cat">${escapeHtml(item.category)}</span>
          <span class="r-status">${item.correction ? 'Correction' : 'On track'}</span>
        </div>
        <div class="r-title">${FLAG_ICON[item.flagId] || '💊'} ${escapeHtml(item.title)}</div>
        <div class="r-body ${item.correction ? 'correction' : ''}">${escapeHtml(item.body)}</div>
      `;
      resultList.appendChild(card);
    }
  }

  if(!results.length){
    resultList.innerHTML = '<p class="helper">No specific lifestyle flags were detected in the label data. Continue following your prescriber\'s instructions as given.</p>';
  }
}

restartBtn.addEventListener('click', () => {
  drugs.length = 0;
  answers = {};
  flagIndex = new Map();
  renderDrugList();
  updateContinueState();
  step1.style.display = 'block';
  step2.style.display = 'none';
  step3.style.display = 'none';
  window.scrollTo({top:0, behavior:'smooth'});
});

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ---------------- accessibility: night mode + growing text size ---------------- */
const themeToggle = document.getElementById('themeToggle');
const textSizeToggle = document.getElementById('textSizeToggle');
const ZOOM_STEPS = [1, 1.15, 1.3, 1.45, 1.6]; // each click grows a bit more, then loops back
let zoomIndex = 0;

function applyZoom(){
  document.body.style.zoom = ZOOM_STEPS[zoomIndex];
  try{ localStorage.setItem('regimen-zoom', zoomIndex); }catch(e){ /* storage unavailable, ignore */ }
}

textSizeToggle.addEventListener('click', () => {
  zoomIndex = (zoomIndex + 1) % ZOOM_STEPS.length;
  applyZoom();
});

function applyTheme(isDark){
  document.documentElement.dataset.theme = isDark ? 'dark' : '';
  themeToggle.textContent = isDark ? '☀️' : '🌙';
  try{ localStorage.setItem('regimen-theme', isDark ? 'dark' : 'light'); }catch(e){ /* storage unavailable, ignore */ }
}

themeToggle.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme !== 'dark');
});

(function initAccessibility(){
  try{
    applyTheme(localStorage.getItem('regimen-theme') === 'dark');
    const savedZoom = parseInt(localStorage.getItem('regimen-zoom'), 10);
    if(!isNaN(savedZoom) && ZOOM_STEPS[savedZoom] !== undefined){ zoomIndex = savedZoom; applyZoom(); }
  }catch(e){ /* storage unavailable, start with defaults */ }
})();