export const BIZAGENT_UI_CSS: string = `
.ba-launcher {
  width: 100%;
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 9px;
  padding: 6px 10px;
  border: 0;
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  font: var(--dsw-font-s-14, 14px/22px var(--dsw-font-family));
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.ba-launcher:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ba-launcher[data-rail='true'] { width: 36px; min-width: 36px; padding: 8px; justify-content: center; }
.ba-launcher:focus-visible,
.ba-button:focus-visible,
.ba-icon-button:focus-visible,
.ba-home-button:focus-visible,
.ba-asset-row:focus-visible,
.ba-input:focus-visible,
.ba-select:focus-visible,
.ba-textarea:focus-visible {
  outline: 2px solid var(--dsw-static-deepseek-450, #5686fe);
  outline-offset: 2px;
}

.ba-overlay {
  --ba-blue: #4176e6;
  --ba-purple: #7357d8;
  --ba-orange: #e58a3a;
  --ba-cyan: #2d9ca8;
  --ba-green: #35a46f;
  position: fixed;
  inset: 0;
  z-index: 120;
  pointer-events: auto;
  display: grid;
  place-items: center;
  padding: 18px;
  background: color-mix(in srgb, var(--dsw-alias-bg-mask-3) 76%, rgba(17, 24, 39, .25));
  backdrop-filter: blur(8px) saturate(.88);
  animation: ba-fade-in 180ms ease-out;
}
.ba-dialog {
  width: min(1480px, 100%);
  height: min(920px, 100%);
  min-height: 560px;
  overflow: hidden;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 18px;
  box-shadow: 0 24px 80px rgba(10, 18, 35, .24), 0 2px 10px rgba(10, 18, 35, .12);
  animation: ba-rise 220ms cubic-bezier(.2,.8,.2,1);
}
.ba-topbar {
  min-height: 74px;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 14px 18px 14px 22px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--ba-blue) 9%, transparent), transparent 30%),
    var(--dsw-alias-bg-layer-1);
}
.ba-brand-sigil {
  position: relative;
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  border: 1px solid color-mix(in srgb, var(--ba-blue) 45%, var(--dsw-alias-border-l3));
  border-radius: 11px;
  background: color-mix(in srgb, var(--ba-blue) 9%, var(--dsw-alias-bg-layer-2));
  overflow: hidden;
}
.ba-brand-sigil::before,
.ba-brand-sigil::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  height: 4px;
  border-radius: 4px;
  background: var(--ba-blue);
  box-shadow: 0 7px 0 var(--ba-purple), 0 14px 0 var(--ba-orange);
}
.ba-brand-sigil::before { top: 8px; transform: skewX(-18deg); }
.ba-brand-sigil::after { top: 8px; opacity: .18; transform: translateX(4px); }
.ba-title-wrap { min-width: 0; flex: 1; }
.ba-eyebrow {
  margin: 0 0 2px;
  color: var(--ba-blue);
  font: 600 10px/14px var(--ds-font-family-code);
  letter-spacing: .13em;
}
.ba-title {
  margin: 0;
  font: 650 19px/25px var(--dsw-font-family);
  letter-spacing: -.015em;
}
.ba-subtitle { margin: 1px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 17px; }
.ba-top-actions { display: flex; align-items: center; gap: 8px; }
.ba-health {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 30px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
  font-size: 11px;
}
.ba-health-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ba-green); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ba-green) 16%, transparent); }
.ba-health[data-ok='false'] .ba-health-dot { background: var(--ba-orange); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ba-orange) 18%, transparent); }
.ba-icon-button {
  width: 34px;
  height: 34px;
  display: inline-grid;
  place-items: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 9px;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  cursor: pointer;
}
.ba-icon-button:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.ba-icon-button:disabled { opacity: .45; cursor: default; }

.ba-body {
  min-height: 0;
  display: grid;
  grid-template-columns: 244px minmax(480px, 1fr) 326px;
}
.ba-directory,
.ba-proposals {
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-module-platform);
}
.ba-directory { border-right: 1px solid var(--dsw-alias-border-l2); }
.ba-proposals { border-left: 1px solid var(--dsw-alias-border-l2); }
.ba-pane-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 16px 12px;
}
.ba-pane-title { margin: 0; font: 600 12px/18px var(--ds-font-family-code); letter-spacing: .04em; text-transform: uppercase; }
.ba-pane-meta { color: var(--dsw-alias-label-caption); font: 11px/16px var(--ds-font-family-code); }
.ba-create-button {
  margin: 0 12px 12px;
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 1px dashed color-mix(in srgb, var(--ba-blue) 48%, var(--dsw-alias-border-l3));
  border-radius: 9px;
  color: var(--ba-blue);
  background: color-mix(in srgb, var(--ba-blue) 6%, transparent);
  font: 500 12px/18px var(--dsw-font-family);
  cursor: pointer;
}
.ba-create-button:hover { background: color-mix(in srgb, var(--ba-blue) 12%, transparent); }
.ba-home-list,
.ba-proposal-list,
.ba-asset-list { list-style: none; margin: 0; padding: 0; }
.ba-home-list { min-height: 0; overflow: auto; padding: 0 8px 14px; }
.ba-home-button {
  width: 100%;
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  padding: 10px 9px;
  border: 0;
  border-radius: 10px;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.ba-home-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ba-home-button[data-active='true'] { color: var(--dsw-alias-label-primary); background: var(--dsw-specific-sidebar-nav-item-active); }
.ba-home-type-dot { width: 8px; height: 8px; border-radius: 3px; background: var(--ba-blue); transform: rotate(45deg); }
.ba-home-type-dot[data-type='business'] { background: var(--ba-orange); }
.ba-home-type-dot[data-type='role'] { background: var(--ba-purple); }
.ba-home-type-dot[data-type='capability'] { background: var(--ba-cyan); }
.ba-home-copy { min-width: 0; }
.ba-home-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 550 13px/18px var(--dsw-font-family); }
.ba-home-address { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-caption); font: 10px/15px var(--ds-font-family-code); }
.ba-home-badge { min-width: 20px; height: 20px; display: grid; place-items: center; padding: 0 5px; border-radius: 999px; color: #fff; background: var(--ba-orange); font: 600 10px/20px var(--ds-font-family-code); }

.ba-workspace { min-width: 0; min-height: 0; overflow: auto; padding: 24px clamp(18px, 3vw, 38px) 34px; background: var(--dsw-alias-bg-base); }
.ba-home-hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 34%); gap: 24px; align-items: start; }
.ba-type-label { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; color: var(--dsw-alias-label-tertiary); font: 600 10px/14px var(--ds-font-family-code); letter-spacing: .09em; text-transform: uppercase; }
.ba-home-heading { margin: 0; font: 650 clamp(23px, 2.4vw, 32px)/1.12 var(--dsw-font-family); letter-spacing: -.035em; }
.ba-address-line { margin-top: 8px; color: var(--dsw-alias-label-caption); font: 11px/18px var(--ds-font-family-code); }
.ba-home-stats { display: flex; flex-wrap: wrap; gap: 7px 15px; margin-top: 13px; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.ba-home-stats span { display: inline-flex; align-items: center; gap: 6px; }
.ba-home-stats span::before { content: ''; width: 4px; height: 4px; border-radius: 50%; background: var(--ba-blue); }
.ba-identity {
  margin: 0;
  padding: 14px 15px;
  border-left: 3px solid var(--ba-blue);
  border-radius: 0 10px 10px 0;
  color: var(--dsw-alias-label-secondary);
  background: color-mix(in srgb, var(--ba-blue) 5%, var(--dsw-alias-bg-layer-2));
}
.ba-identity-label { display: block; margin-bottom: 6px; color: var(--ba-blue); font: 600 9px/13px var(--ds-font-family-code); letter-spacing: .08em; text-transform: uppercase; }
.ba-identity-body { margin: 0; display: -webkit-box; overflow: hidden; -webkit-line-clamp: 4; -webkit-box-orient: vertical; white-space: pre-wrap; font-size: 11px; line-height: 17px; }

.ba-strata { margin-top: 25px; }
.ba-section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
.ba-section-heading h3 { margin: 0; font: 620 13px/19px var(--dsw-font-family); }
.ba-section-heading p { margin: 0; color: var(--dsw-alias-label-caption); font-size: 10px; }
.ba-strata-track {
  display: grid;
  grid-template-columns: repeat(5, minmax(78px, 1fr));
  min-height: 102px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
}
.ba-stratum { position: relative; min-width: 0; padding: 13px 12px 11px; border-right: 1px solid var(--dsw-alias-border-l2); }
.ba-stratum:last-child { border-right: 0; }
.ba-stratum::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: var(--stratum-color); opacity: .8; }
.ba-stratum[data-kind='episode'] { --stratum-color: #8b98aa; }
.ba-stratum[data-kind='memory'] { --stratum-color: var(--ba-blue); }
.ba-stratum[data-kind='insight'] { --stratum-color: var(--ba-purple); }
.ba-stratum[data-kind='knowledge'] { --stratum-color: var(--ba-cyan); }
.ba-stratum[data-kind='method'] { --stratum-color: var(--ba-orange); }
.ba-stratum-label { display: block; color: var(--dsw-alias-label-tertiary); font: 9px/13px var(--ds-font-family-code); letter-spacing: .06em; text-transform: uppercase; }
.ba-stratum-count { display: block; margin-top: 2px; font: 650 22px/27px var(--ds-font-family-code); letter-spacing: -.04em; }
.ba-stratum-grains { position: absolute; left: 12px; right: 12px; bottom: 15px; display: flex; flex-wrap: wrap; gap: 3px; max-height: 24px; overflow: hidden; }
.ba-grain { width: 4px; height: 4px; border-radius: 1px; background: var(--stratum-color); opacity: .62; }
.ba-grain:nth-child(3n) { width: 9px; opacity: .28; }

.ba-ledger { margin-top: 27px; }
.ba-ledger-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 11px; }
.ba-ledger-title { display: flex; align-items: baseline; gap: 10px; }
.ba-ledger-title h3 { margin: 0; font: 620 14px/20px var(--dsw-font-family); }
.ba-ledger-count { color: var(--dsw-alias-label-caption); font: 10px/15px var(--ds-font-family-code); }
.ba-filters { display: flex; align-items: center; gap: 7px; }
.ba-search-wrap { position: relative; min-width: 180px; }
.ba-search-icon { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); color: var(--dsw-alias-label-caption); pointer-events: none; }
.ba-input,
.ba-select,
.ba-textarea {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  font: 12px/18px var(--dsw-font-family);
}
.ba-input { width: 100%; height: 32px; padding: 0 10px 0 29px; }
.ba-select { height: 32px; padding: 0 26px 0 9px; }
.ba-textarea { width: 100%; min-height: 82px; resize: vertical; padding: 9px 10px; }
.ba-input::placeholder,
.ba-textarea::placeholder { color: var(--dsw-alias-label-caption); }
.ba-asset-list { border-top: 1px solid var(--dsw-alias-border-l2); }
.ba-asset-item { border-bottom: 1px solid var(--dsw-alias-border-l2); }
.ba-asset-row {
  width: 100%;
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr) auto;
  gap: 13px;
  align-items: start;
  padding: 13px 5px;
  border: 0;
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.ba-asset-row:hover .ba-asset-description { color: var(--ba-blue); }
.ba-kind-chip { width: max-content; padding: 3px 6px; border-radius: 5px; color: var(--kind-color); background: color-mix(in srgb, var(--kind-color) 10%, transparent); font: 600 9px/13px var(--ds-font-family-code); text-transform: uppercase; }
.ba-kind-chip[data-kind='memory'] { --kind-color: var(--ba-blue); }
.ba-kind-chip[data-kind='insight'] { --kind-color: var(--ba-purple); }
.ba-kind-chip[data-kind='knowledge'] { --kind-color: var(--ba-cyan); }
.ba-kind-chip[data-kind='method'] { --kind-color: var(--ba-orange); }
.ba-asset-description { display: block; font: 550 12px/18px var(--dsw-font-family); transition: color 120ms ease; }
.ba-asset-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
.ba-tag { color: var(--dsw-alias-label-caption); font: 9px/13px var(--ds-font-family-code); }
.ba-tag::before { content: '#'; color: var(--ba-blue); }
.ba-asset-metrics { display: flex; gap: 9px; color: var(--dsw-alias-label-caption); font: 9px/14px var(--ds-font-family-code); white-space: nowrap; }
.ba-fitness { color: var(--ba-green); }
.ba-fitness[data-negative='true'] { color: var(--dsw-alias-state-error-primary); }
.ba-asset-detail { margin: 0 0 14px 91px; padding: 14px 15px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); animation: ba-detail 140ms ease-out; }
.ba-detail-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ba-detail-revision { color: var(--dsw-alias-label-caption); font: 9px/14px var(--ds-font-family-code); }
.ba-detail-copy { margin: 12px 0 0; white-space: pre-wrap; color: var(--dsw-alias-label-secondary); font: 12px/19px var(--dsw-font-family); }
.ba-evidence { margin-top: 14px; padding-top: 11px; border-top: 1px dashed var(--dsw-alias-border-l3); }
.ba-evidence h4 { margin: 0 0 7px; color: var(--dsw-alias-label-tertiary); font: 600 9px/13px var(--ds-font-family-code); letter-spacing: .07em; text-transform: uppercase; }
.ba-evidence code { display: block; overflow-wrap: anywhere; margin-top: 4px; color: var(--dsw-alias-label-caption); font: 9px/14px var(--ds-font-family-code); }

.ba-proposals .ba-pane-head { align-items: baseline; }
.ba-proposal-list { min-height: 0; overflow: auto; padding: 0 11px 16px; }
.ba-proposal-card { margin-bottom: 9px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 11px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.ba-proposal-summary { width: 100%; padding: 13px; border: 0; color: inherit; background: transparent; text-align: left; cursor: pointer; }
.ba-proposal-summary:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ba-proposal-route { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; color: var(--ba-orange); font: 600 9px/13px var(--ds-font-family-code); }
.ba-proposal-description { margin: 0; font: 550 12px/18px var(--dsw-font-family); }
.ba-proposal-body { margin: 7px 0 0; display: -webkit-box; overflow: hidden; -webkit-line-clamp: 3; -webkit-box-orient: vertical; color: var(--dsw-alias-label-tertiary); font-size: 10px; line-height: 16px; }
.ba-proposal-form { padding: 0 13px 13px; border-top: 1px solid var(--dsw-alias-border-l2); }
.ba-field-label { display: block; margin: 11px 0 5px; color: var(--dsw-alias-label-tertiary); font: 600 9px/13px var(--ds-font-family-code); letter-spacing: .05em; text-transform: uppercase; }
.ba-proposal-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 9px; }
.ba-button {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  font: 550 11px/17px var(--dsw-font-family);
  cursor: pointer;
}
.ba-button:hover { background: var(--dsw-alias-interactive-bg-hover-solid); }
.ba-button[data-variant='primary'] { border-color: var(--ba-blue); color: #fff; background: var(--ba-blue); }
.ba-button[data-variant='primary']:hover { filter: brightness(1.08); }
.ba-button[data-variant='danger'] { color: var(--dsw-alias-state-error-primary); }
.ba-button:disabled { opacity: .5; cursor: default; }
.ba-inline-error { margin: 8px 0 0; color: var(--dsw-alias-state-error-primary); font-size: 10px; line-height: 15px; }

.ba-empty { padding: 30px 18px; color: var(--dsw-alias-label-tertiary); text-align: center; }
.ba-empty-mark { width: 34px; height: 24px; margin: 0 auto 10px; border-top: 2px solid var(--ba-blue); border-bottom: 2px solid var(--ba-orange); position: relative; opacity: .65; }
.ba-empty-mark::after { content: ''; position: absolute; left: 3px; right: 3px; top: 9px; border-top: 2px solid var(--ba-purple); }
.ba-empty strong { display: block; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.ba-empty p { max-width: 280px; margin: 5px auto 0; font-size: 10px; line-height: 16px; }
.ba-loading { min-height: 0; display: grid; place-items: center; color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-base); }
.ba-loading-core { display: grid; justify-items: center; gap: 14px; font-size: 12px; }
.ba-loading-strata { width: 92px; height: 24px; position: relative; }
.ba-loading-strata span { position: absolute; left: 0; height: 3px; border-radius: 3px; animation: ba-pulse 1.1s ease-in-out infinite alternate; }
.ba-loading-strata span:nth-child(1) { top: 0; width: 72%; background: var(--ba-blue); }
.ba-loading-strata span:nth-child(2) { top: 9px; width: 100%; background: var(--ba-purple); animation-delay: 120ms; }
.ba-loading-strata span:nth-child(3) { top: 18px; width: 48%; background: var(--ba-orange); animation-delay: 240ms; }

.ba-modal-layer { position: absolute; inset: 0; z-index: 4; display: grid; place-items: center; padding: 20px; background: var(--dsw-alias-bg-mask-2); backdrop-filter: blur(3px); }
.ba-form-card { width: min(520px, 100%); max-height: 90%; overflow: auto; padding: 20px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 14px; background: var(--dsw-alias-bg-layer-1); box-shadow: 0 18px 55px rgba(10,18,35,.18); }
.ba-form-card h3 { margin: 0; font: 650 18px/24px var(--dsw-font-family); }
.ba-form-subtitle { margin: 5px 0 17px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 17px; }
.ba-form-grid { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 12px; }
.ba-form-field .ba-input { height: 36px; padding-left: 10px; }
.ba-form-field .ba-select { width: 100%; height: 36px; }
.ba-form-field[data-wide='true'] { grid-column: 1 / -1; }
.ba-address-preview { margin-top: 12px; padding: 8px 10px; border-radius: 7px; color: var(--ba-blue); background: color-mix(in srgb, var(--ba-blue) 7%, transparent); font: 10px/15px var(--ds-font-family-code); }
.ba-form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }

@media (max-width: 1120px) {
  .ba-body { grid-template-columns: 220px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; }
  .ba-directory { grid-row: 1 / 3; }
  .ba-proposals { max-height: 300px; border-left: 0; border-top: 1px solid var(--dsw-alias-border-l2); }
  .ba-proposal-list { display: grid; grid-template-columns: repeat(2, minmax(240px, 1fr)); gap: 9px; }
  .ba-proposal-card { margin: 0; }
}
@media (max-width: 760px) {
  .ba-overlay { padding: 0; }
  .ba-dialog { width: 100%; height: 100%; min-height: 0; border: 0; border-radius: 0; }
  .ba-topbar { min-height: 64px; padding: 10px 12px; }
  .ba-brand-sigil { display: none; }
  .ba-subtitle, .ba-health { display: none; }
  .ba-body { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr) auto; }
  .ba-directory { grid-row: auto; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
  .ba-directory .ba-pane-head { padding: 10px 12px 5px; }
  .ba-create-button { position: absolute; right: 54px; top: 17px; width: 34px; min-height: 32px; margin: 0; border-style: solid; font-size: 0; }
  .ba-home-list { display: flex; gap: 6px; overflow-x: auto; padding: 5px 9px 10px; }
  .ba-home-list li { flex: 0 0 190px; }
  .ba-workspace { padding: 18px 14px 28px; }
  .ba-home-hero { grid-template-columns: 1fr; gap: 14px; }
  .ba-strata-track { overflow-x: auto; grid-template-columns: repeat(5, minmax(100px, 1fr)); }
  .ba-ledger-head { align-items: flex-start; flex-direction: column; }
  .ba-filters { width: 100%; flex-wrap: wrap; }
  .ba-search-wrap { min-width: 100%; }
  .ba-asset-row { grid-template-columns: 70px minmax(0, 1fr); }
  .ba-asset-metrics { grid-column: 2; }
  .ba-asset-detail { margin-left: 0; }
  .ba-proposals { max-height: 260px; }
  .ba-proposal-list { display: flex; overflow-x: auto; padding-bottom: 11px; }
  .ba-proposal-card { flex: 0 0 292px; }
  .ba-form-grid { grid-template-columns: 1fr; }
  .ba-form-field[data-wide='true'] { grid-column: auto; }
}
@media (prefers-reduced-motion: reduce) {
  .ba-overlay, .ba-dialog, .ba-asset-detail, .ba-loading-strata span { animation: none !important; }
  .ba-launcher, .ba-asset-description { transition: none; }
}
@keyframes ba-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes ba-rise { from { opacity: 0; transform: translateY(10px) scale(.99); } to { opacity: 1; transform: none; } }
@keyframes ba-detail { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
@keyframes ba-pulse { from { opacity: .25; transform: scaleX(.72); transform-origin: left; } to { opacity: .9; transform: scaleX(1); transform-origin: left; } }
`
