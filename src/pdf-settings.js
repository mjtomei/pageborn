export const PDF_DEFAULTS = Object.freeze({ mode: 'auto', keepMarginNotes: false, keepRepeatedText: false,
  normalizeColors: true, reflow: true, textSize: 20 });
const legacyFields = { mode: 'pdfLayouts', keepMarginNotes: 'pdfMarginNotes', keepRepeatedText: 'pdfRepeatedText',
  normalizeColors: 'pdfNormalizeColors', reflow: 'pdfReflow', textSize: 'pdfTextSizes' };

export function normalizePdfSettings(settings = {}) {
  const result = { ...PDF_DEFAULTS };
  if (['auto', 'single', 'double'].includes(settings.mode)) result.mode = settings.mode;
  if ([20, 24, 28].includes(Number(settings.textSize))) result.textSize = Number(settings.textSize);
  for (const key of Object.keys(result)) if (typeof result[key] === 'boolean' && typeof settings[key] === 'boolean') result[key] = settings[key];
  return result;
}

export function pdfSettingsFor(preferences, key) {
  preferences.pdfSettings ||= {};
  if (!preferences.pdfSettings[key]) {
    const legacy = {};
    for (const [name, field] of Object.entries(legacyFields)) {
      if (Object.hasOwn(preferences[field] || {}, key)) legacy[name] = preferences[field][key];
    }
    // Previously opened PDFs used factory defaults for their unspecified fields.
    // Snapshot all fields on first open so later default changes affect only new PDFs.
    const existing = preferences.positions?.[key]?.pdf || Object.keys(legacy).length;
    preferences.pdfSettings[key] = normalizePdfSettings({ ...(existing ? PDF_DEFAULTS : preferences.pdfDefaults), ...legacy });
  }
  delete preferences.pdfSettings[key].fitFigures;
  return preferences.pdfSettings[key];
}

export function usePdfDefaults(preferences, key) {
  const settings = normalizePdfSettings(preferences.pdfDefaults);
  (preferences.pdfSettings ||= {})[key] = settings;
  return settings;
}

export function forgetPdfSettings(preferences, key) {
  if (preferences.pdfSettings) delete preferences.pdfSettings[key];
  for (const field of [...Object.values(legacyFields), 'pdfFitFigures']) if (preferences[field]) delete preferences[field][key];
}
