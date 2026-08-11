'use strict';

// A28 theme stylesheet generation.
//
// The storefront CSP is `style-src 'self'` with `style-src-attr 'none'`, so a theme can
// NOT be applied with element.style, a style="" attribute, or an injected <style> block.
// A28 does not relax that. Instead the server renders the validated tokens into a real
// stylesheet served from the same origin, and the page links it like any other CSS file.
//
// Everything written here has already been through modules/themes/schema.js, which makes
// ';', '{', '}', 'url(' and '@import' impossible in a token value. This module additionally
// refuses to emit any declaration whose value does not match a final safety pattern, so a
// future schema change cannot silently open a CSS-injection hole here.

const { themeCssVariables } = require('./schema');

// Belt-and-braces: the only value shapes a token may take once rendered.
const SAFE_VALUE = /^(#[0-9a-f]{6}|-?\d{1,5}px|[A-Za-z0-9 '\-,.]+)$/;
const SAFE_PROPERTY = /^--theme-[a-z-]+$/;

function assertSafeDeclaration(property, value) {
  if (!SAFE_PROPERTY.test(property)) {
    throw Object.assign(new Error(`Guvensiz CSS ozelligi: ${property}`), { code: 'THEME_UNSAFE_CSS_PROPERTY', status: 500 });
  }
  const text = String(value);
  if (!SAFE_VALUE.test(text)) {
    throw Object.assign(new Error('Guvensiz CSS degeri'), { code: 'THEME_UNSAFE_CSS_VALUE', status: 500 });
  }
  return `${property}:${text}`;
}

// The storefront pages and shared.css already read a fixed set of palette variables. Mapping
// the theme onto those exact names is what makes a published theme change the real site
// instead of introducing a second, parallel variable set that nothing reads.
//
// Every entry here is an EXACT parity mapping: the default token value equals the value the
// pages hard-code today, so a tenant on the backfilled default theme renders unchanged.
// Variables whose current value has no matching token (--lighter, --green-dark, --marmara,
// --line, ...) are deliberately left alone rather than approximated.
const LEGACY_ALIASES = Object.freeze([
  ['--bg', '--theme-background'],
  ['--white', '--theme-surface'],
  ['--black', '--theme-text'],
  ['--mid', '--theme-muted-text'],
  ['--light', '--theme-border'],
  ['--accent', '--theme-primary'],
  ['--copper', '--theme-accent'],
  ['--sans', '--theme-font-body'],
  ['--serif', '--theme-font-heading'],
]);

function renderThemeCss(config) {
  const declarations = themeCssVariables(config).map(([property, value]) => assertSafeDeclaration(property, value));
  // Aliases reference the theme variables rather than repeating their values, so the two
  // can never drift apart.
  const aliases = LEGACY_ALIASES.map(([legacy, themeVar]) => `${legacy}:var(${themeVar})`);
  return [
    '/* Panelya theme tokens - generated from a validated theme version. */',
    // `:root:root` doubles the specificity of a plain `:root`, so the theme wins over each
    // page's own palette block no matter where the browser ends up ordering this stylesheet.
    // That removes any dependence on <link> order, which pages control and themes do not.
    ':root:root{',
    [...declarations, ...aliases].join(';'),
    '}',
    '.theme-container{max-width:var(--theme-container-max);padding-left:var(--theme-container-padding);padding-right:var(--theme-container-padding);margin-left:auto;margin-right:auto}',
    '.theme-surface{background:var(--theme-surface)}',
    '.theme-muted{color:var(--theme-muted-text)}',
    '.theme-accent{color:var(--theme-accent)}',
    '.theme-radius{border-radius:var(--theme-radius)}',
    '.theme-primary-btn{background:var(--theme-primary);color:var(--theme-primary-contrast);border-radius:var(--theme-radius)}',
    '.theme-section{padding-top:calc(var(--theme-spacing) * 2);padding-bottom:calc(var(--theme-spacing) * 2)}',
  ].join('\n');
}

module.exports = {
  LEGACY_ALIASES,
  SAFE_VALUE,
  SAFE_PROPERTY,
  assertSafeDeclaration,
  renderThemeCss,
};
