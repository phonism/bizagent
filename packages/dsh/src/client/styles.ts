export const BIZAGENT_UI_CSS: string = `
.ba-panel-icon { display: inline-block; color: var(--dsw-alias-label-secondary); }
.ba-panel-icon .ba-mark-base { fill: #2949eb; }
.ba-panel-icon .ba-mark-middle { fill: #70b6b0; }
.ba-panel-icon .ba-mark-top { fill: currentColor; }
.ba-overlay.ba-panel { position: relative; inset: auto; width: 100%; height: 100%; min-height: 0;
  padding: 0; display: block; z-index: auto; background: var(--dsw-alias-bg-base); backdrop-filter: none; animation: none; }
.ba-panel > .ba-dialog { width: 100%; height: 100%; min-height: 0; border: 0; border-radius: 0; box-shadow: none; animation: none; }
.ba-session-actions { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ba-session-home, .ba-session-project, .ba-session-detail { display: inline-flex; align-items: center;
  gap: 6px; max-width: 230px; min-height: 28px; padding: 3px 8px; border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.ba-session-home > span:not(.ba-session-symbol):not(.ba-count), .ba-session-project { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ba-session-home small { white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 10px; }
.ba-session-home:hover, .ba-session-project:hover, .ba-session-detail:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ba-session-symbol { color: #526ff5; font-size: 19px; }
.ba-count { min-width: 16px; padding: 0 4px; border-radius: 4px; background: color-mix(in srgb, #526ff5 12%, transparent); color: #526ff5; text-align: center; font-size: 10px; }
.ba-session-row-mark { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; color: #526ff5; font: 14px/1 sans-serif; }
.ba-session-row-mark[data-kind='work'] { color: #24868f; }
.ba-session-row-mark[data-kind='learning'] { color: #9469df; }
.ba-session-hover { display: grid; gap: 3px; padding: 5px 0; color: var(--dsw-alias-label-secondary); font-size: 11px; overflow-wrap: anywhere; }
.ba-session-menu { display: block; width: 100%; padding: 8px 12px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); text-align: left; font: inherit; cursor: pointer; }
.ba-session-menu:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ba-session-workspace { box-sizing: border-box; width: 100%; height: 100%; overflow: auto; padding: 24px max(20px, calc((100% - 900px) / 2));
  padding-bottom: calc(var(--dsh-composer-height, 180px) + 40px);
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font-family: var(--ds-font-family, inherit); }
.ba-session-workspace *, .ba-turn-receipt * { box-sizing: border-box; }
.ba-session-workspace-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
.ba-session-workspace h2 { margin: 0; font-size: 22px; font-weight: 650; }
.ba-session-workspace-header p { margin: 6px 0 0; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.ba-session-home-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding-bottom: 18px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.ba-session-home-summary > .ba-session-symbol { font-size: 30px; }
.ba-session-home-summary > div { flex: 1; min-width: 120px; }
.ba-session-home-summary strong { font-size: 16px; font-weight: 650; }
.ba-session-home-summary p, .ba-session-hint { margin: 5px 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ba-session-attention { display: block; width: 100%; margin: 14px 0; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2); border-left: 3px solid #9469df;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); border-radius: 4px; font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.ba-session-section { margin: 24px 0; }
.ba-session-section > h3 { margin: 0 0 8px; font-size: 15px; font-weight: 650; }
.ba-session-empty { padding: 18px 0; margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.7; }
.ba-session-work-card { margin-top: 14px; padding: 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.ba-session-card-title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.ba-session-card-title h4 { margin: 0; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.ba-work-status { flex-shrink: 0; padding: 3px 6px; border-radius: 4px; font-size: 11px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.ba-work-status[data-status='completed'] { color: #24868f; background: color-mix(in srgb, #24868f 10%, transparent); }
.ba-session-route { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0; color: var(--dsw-alias-label-secondary); font-size: 11px; overflow-wrap: anywhere; }
.ba-session-result { margin: 12px 0; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2); font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
.ba-session-result summary { cursor: pointer; font-weight: 600; }
.ba-session-result p { white-space: pre-wrap; }
.ba-session-card-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.ba-session-project-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; width: 100%; padding: 12px 0;
  border: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer; }
.ba-session-project-row span { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.ba-session-activity { list-style: none; margin: 0; padding: 0; }
.ba-session-activity > li { display: flex; align-items: flex-start; gap: 10px; padding: 12px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.ba-session-activity-symbol { color: #526ff5; }
.ba-session-activity > li > div { flex: 1; min-width: 0; }
.ba-session-activity strong { font-size: 12px; font-weight: 600; }
.ba-session-activity small { margin-left: 8px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.ba-session-activity p { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.ba-turn-receipt { margin: 10px 0 4px; padding: 8px 12px; border-left: 2px solid #526ff5; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.ba-turn-receipt > summary { cursor: pointer; }
.ba-session-workspace button:focus-visible, .ba-session-home:focus-visible, .ba-session-project:focus-visible,
.ba-session-menu:focus-visible, .ba-turn-receipt button:focus-visible, .ba-turn-receipt summary:focus-visible { outline: 2px solid #5686fe; outline-offset: 2px; }
@media (max-width: 700px) {
  .ba-session-home { max-width: 150px; }
  .ba-session-home small, .ba-session-project { display: none; }
  .ba-session-workspace { padding: 16px 16px calc(var(--dsh-composer-height, 180px) + 24px); }
  .ba-session-card-title { align-items: flex-start; }
  .ba-panel .ba-topbar { flex-wrap: wrap; gap: 10px; padding: 12px; }
  .ba-panel .ba-view-tabs { order: 3; width: 100%; overflow: auto; }
}
.ba-launcher, .ba-overlay {
  --ba-brand: #2949eb;
  --ba-coral: #ff9278;
  --ba-aqua: #70e6df;
  --ba-display: 'Avenir Next', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
.ba-mark { display: block; width: 100%; height: 100%; overflow: visible; flex: 0 0 auto; }
.ba-mark-base { fill: var(--ba-coral); }
.ba-mark-middle { fill: var(--ba-aqua); }
.ba-mark-top { fill: #fff; }
.ba-frame-dock, .ba-frame-dock * { box-sizing: border-box; }
.ba-frame-dock {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  width: min(100%, 780px); margin-inline: auto;
  padding: 7px 11px; border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-base); font: 11px/17px var(--ds-font-family-code);
}
.ba-frame-dock-label { margin-right: 3px; color: var(--dsw-alias-label-caption); font-weight: 650; }
.ba-frame-chip { max-width: 100%; overflow: hidden; padding: 3px 8px; border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l2); text-overflow: ellipsis; white-space: nowrap; }
.ba-frame-chip > span { color: #3654ca; font-weight: 700; }
.ba-frame-chip[data-mode='reference'] > span { color: var(--dsw-alias-label-caption); }
.ba-frame-chip[data-mode='contribute'] > span { color: #167b72; }
.ba-frame-chip b { font-weight: 600; }
.ba-frame-dock button.ba-frame-chip { background: transparent; color: inherit; font: inherit; cursor: pointer; }
.ba-frame-dock button.ba-frame-chip:hover { border-color: #526ff5; }
.ba-frame-dock button.ba-frame-chip:focus-visible { outline: 2px solid #5686fe; outline-offset: 2px; }
.ba-frame-stale { color: #a75d21; }
.ba-frame-dock-note { color: var(--dsw-alias-label-caption); font-size: 10px; }
.ba-overlay, .ba-overlay *, .ba-overlay *::before, .ba-overlay *::after { box-sizing: border-box; }
.ba-launcher {
  box-sizing: border-box;
  width: 100%;
  min-height: 66px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid #4562ff;
  border-bottom: 4px solid var(--ba-coral);
  border-radius: 15px;
  color: #fff;
  background: var(--ba-brand);
  box-shadow: 0 5px 15px #2949eb26;
  font: 700 15px/22px var(--ba-display);
  cursor: pointer;
  transition: background 140ms ease, transform 140ms ease;
}
.ba-launcher:hover { background: #1935bd; transform: translateY(-2px); }
.ba-launcher[aria-pressed='true'] { background: #1935bd; }
.ba-launcher > .ba-mark { width: 34px; height: 34px; }
.ba-launcher[data-rail='true'] { width: 40px; min-width: 40px; min-height: 44px; padding: 6px; justify-content: center; border-radius: 12px; }
.ba-launcher[data-rail='true'] > .ba-mark { width: 26px; height: 26px; }
.ba-launcher-copy { min-width: 0; display: grid; text-align: left; }
.ba-launcher-copy > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ba-launcher-copy small { overflow: hidden; color: #e0e5ff; font: 11px/17px var(--ba-display); text-overflow: ellipsis; white-space: nowrap; }
.ba-overlay button:focus-visible,
.ba-overlay summary:focus-visible,
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
  --ba-blue: #526ff5;
  --ba-purple: #9469df;
  --ba-orange: #cd6835;
  --ba-cyan: #24868f;
  --ba-green: #35a46f;
  position: fixed;
  inset: 0;
  z-index: 120;
  pointer-events: auto;
  display: grid;
  place-items: center;
  padding: 18px;
  background: color-mix(in srgb, var(--dsw-alias-bg-mask-3) 76%, rgba(31, 44, 110, .35));
  backdrop-filter: blur(8px) saturate(.88);
  animation: ba-fade-in 180ms ease-out;
}
.ba-dialog {
  width: min(1480px, 100%);
  height: min(920px, 100%);
  min-height: min(560px, 100%);
  overflow: hidden;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid color-mix(in srgb, var(--ba-brand) 32%, var(--dsw-alias-border-l3));
  border-radius: 24px;
  box-shadow: 0 28px 90px rgba(20, 35, 104, .3), 0 0 0 5px #7387ff1a;
  animation: ba-rise 220ms cubic-bezier(.2,.8,.2,1);
}
.ba-dialog:has(.ba-local-human-auth) { grid-template-rows: auto auto minmax(0, 1fr); }
.ba-local-human-auth { padding: 8px 20px; border-bottom: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); font-size: 11px; }
.ba-local-human-auth form, .ba-local-human-auth { align-items: center; gap: 8px; }
.ba-local-human-auth form { display: flex; flex-wrap: wrap; }
.ba-local-human-auth input { min-width: 180px; max-width: 360px; flex: 1; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 7px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); }
.ba-local-human-auth button { padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 7px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); cursor: pointer; }
.ba-local-human-auth button:disabled { opacity: .5; cursor: default; }
.ba-local-human-auth [role='alert'] { color: var(--dsw-alias-state-error-primary); }
.ba-topbar {
  min-height: 74px;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 14px 18px 14px 22px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.ba-brand-sigil {
  box-sizing: border-box;
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  padding: 6px;
  border-radius: 13px;
  background: var(--ba-brand);
}
.ba-title-wrap { min-width: 0; flex: 1; }
.ba-eyebrow {
  margin: 0 0 2px;
  color: var(--ba-blue);
  font: 600 10px/14px var(--ds-font-family-code);
  letter-spacing: .13em;
}
.ba-title {
  margin: 0;
  font: 750 25px/30px var(--ba-display);
  letter-spacing: -.04em;
}
.ba-subtitle { margin: 1px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 17px; }
.ba-top-actions { display: flex; align-items: center; gap: 8px; }
.ba-current-location { max-width: 330px; min-height: 30px; display: flex; align-items: center; gap: 6px; padding: 0 10px; border: 1px solid color-mix(in srgb, var(--ba-purple) 28%, var(--dsw-alias-border-l2)); border-radius: 999px; background: color-mix(in srgb, var(--ba-purple) 6%, var(--dsw-alias-bg-layer-2)); font-size: 10px; }
.ba-current-location strong,
.ba-current-location code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ba-current-location strong { max-width: 150px; font-size: 11px; }
.ba-current-location > span { color: var(--dsw-alias-label-caption); }
.ba-current-location code { color: var(--ba-purple); font: 9px/14px var(--ds-font-family-code); }
.ba-current-location[data-scope="personal"] { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.ba-current-location[data-scope="personal"] code { color: var(--dsw-alias-label-secondary); }
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
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 244px minmax(480px, 1fr) 326px;
}
.ba-directory,
.ba-proposals {
  min-width: 0;
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
.ba-home-group { display: contents; }
.ba-home-group-title { margin: 6px 16px 4px; color: var(--dsw-alias-label-caption); font-size: 11px; font-weight: 600; }
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
.ba-home-button[data-active='true'] { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--ba-blue) 16%, var(--dsw-alias-bg-layer-1)); box-shadow: inset 3px 0 0 var(--ba-blue); }
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
.ba-home-heading { margin: 0; font: 750 clamp(28px, 2.7vw, 38px)/1.12 var(--ba-display); letter-spacing: -.035em; overflow-wrap: anywhere; }
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
  min-height: 120px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
}
.ba-stratum { position: relative; min-width: 0; padding: 15px 14px 11px; border-right: 1px solid var(--dsw-alias-border-l2); background: color-mix(in srgb, var(--stratum-color) 7%, transparent); }
.ba-stratum:last-child { border-right: 0; }
.ba-stratum::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 6px; background: var(--stratum-color); }
.ba-stratum[data-kind='episode'] { --stratum-color: #8b98aa; }
.ba-stratum[data-kind='memory'] { --stratum-color: var(--ba-blue); }
.ba-stratum[data-kind='insight'] { --stratum-color: var(--ba-purple); }
.ba-stratum[data-kind='knowledge'] { --stratum-color: var(--ba-cyan); }
.ba-stratum[data-kind='method'] { --stratum-color: var(--ba-orange); }
.ba-stratum-label { display: block; color: var(--dsw-alias-label-secondary); font: 600 11px/16px var(--ba-display); }
.ba-stratum-count { display: block; margin-top: 3px; font: 750 32px/38px var(--ba-display); letter-spacing: -.04em; }
.ba-stratum-grains { position: absolute; left: 12px; right: 12px; bottom: 15px; display: flex; flex-wrap: wrap; gap: 3px; max-height: 24px; overflow: hidden; }
.ba-grain { width: 4px; height: 4px; border-radius: 1px; background: var(--stratum-color); opacity: .62; }
.ba-grain:nth-child(3n) { width: 9px; opacity: .28; }
.ba-ledger { margin-top: 27px; }
.ba-learning-schedule { display: grid; gap: 10px; padding: 16px 18px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.ba-learning-schedule .ba-ledger-head { margin-bottom: 0; }
.ba-learning-schedule p { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.ba-learning-schedule small { color: var(--dsw-alias-label-secondary); }
.ba-learning-schedule-fields { display: flex; flex-wrap: wrap; gap: 12px; }
.ba-learning-schedule-fields label { display: grid; gap: 5px; min-width: 150px; font-size: 12px; }
.ba-learning-schedule-fields label:first-child { display: flex; align-items: center; gap: 8px; }
.ba-learning-schedule-fields .ba-input { width: 100%; }
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
.ba-worklogs { margin-top: 25px; }
.ba-worklog-note { margin: 0; color: var(--dsw-alias-label-caption); font: 10px/16px var(--dsw-font-family); }
.ba-worklog-empty { margin: 0; padding: 18px 5px; border-top: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-tertiary); font: 12px/18px var(--dsw-font-family); }
.ba-worklog-row { grid-template-columns: 78px minmax(0, 1fr) auto; }
.ba-worklog-status[data-status='ongoing'] { --kind-color: var(--ba-blue); }
.ba-worklog-status[data-status='completed'] { --kind-color: var(--ba-green); }
.ba-worklog-status[data-status='blocked'], .ba-worklog-status[data-status='failed'] { --kind-color: var(--ba-orange); }
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
.ba-memory-use { margin-top: 14px; padding-top: 11px; border-top: 1px dashed var(--dsw-alias-border-l3); }
.ba-memory-use h4 { margin: 0 0 7px; color: var(--dsw-alias-label-tertiary); font: 600 9px/13px var(--ds-font-family-code); letter-spacing: .07em; text-transform: uppercase; }
.ba-memory-use > p { margin: 5px 0 8px; color: var(--dsw-alias-label-caption); font: 11px/17px var(--dsw-font-family); }
.ba-memory-use-work { padding: 10px 0; border-top: 1px solid var(--dsw-alias-border-l3); }
.ba-memory-use-work strong, .ba-memory-use-work small { display: block; overflow-wrap: anywhere; }
.ba-memory-use-work small { margin-top: 3px; color: var(--dsw-alias-label-caption); font: 10px/16px var(--dsw-font-family); }
.ba-memory-use-receipts { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.ba-memory-use-receipts span { padding: 3px 6px; border-radius: 5px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font: 10px/15px var(--dsw-font-family); }
.ba-proposals .ba-pane-head { align-items: baseline; }
.ba-shared-knowledge-reviews { min-height: 0; overflow: auto; border-top: 1px solid var(--dsw-alias-border-l2); }
.ba-shared-knowledge-reviews > p { padding: 0 16px 12px; color: var(--dsw-alias-label-caption); }
.ba-shared-knowledge-reviews .ba-proposal-card strong,
.ba-shared-knowledge-reviews .ba-proposal-card small { display: block; overflow-wrap: anywhere; }
.ba-shared-knowledge-reviews .ba-proposal-card small { margin-top: 6px; color: var(--dsw-alias-label-tertiary); }
.ba-proposal-list { min-height: 0; overflow: auto; padding: 0 11px 16px; }
.ba-proposal-card { margin-bottom: 9px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 11px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.ba-proposal-summary { width: 100%; padding: 13px; border: 0; color: inherit; background: transparent; text-align: left; cursor: pointer; }
.ba-proposal-summary:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ba-proposal-route { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; color: var(--ba-orange); font: 600 9px/13px var(--ds-font-family-code); }
.ba-proposal-description { margin: 0; font: 550 12px/18px var(--dsw-font-family); }
.ba-proposal-body { margin: 7px 0 0; display: -webkit-box; overflow: hidden; -webkit-line-clamp: 3; -webkit-box-orient: vertical; color: var(--dsw-alias-label-tertiary); font-size: 10px; line-height: 16px; }
.ba-proposal-form { padding: 0 13px 13px; border-top: 1px solid var(--dsw-alias-border-l2); }
.ba-proposal-target { margin: 11px 0; padding: 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; font-size: 11px; line-height: 16px; }
.ba-proposal-target p { margin: 6px 0 0; }
.ba-proposal-current-body { max-height: 112px; overflow: auto; white-space: pre-wrap; color: var(--dsw-alias-label-tertiary); }
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
.ba-view-tabs {
  align-self: stretch;
  display: flex;
  align-items: flex-end;
  gap: 4px;
  margin: -14px 18px -14px 0;
}
.ba-view-tabs button {
  position: relative;
  height: 100%;
  min-width: 76px;
  padding: 0 15px;
  border: 0;
  color: var(--dsw-alias-label-tertiary);
  background: transparent;
  font: 650 13px/20px var(--ba-display);
  cursor: pointer;
}
.ba-view-tabs button:hover { color: var(--dsw-alias-label-primary); }
.ba-view-tabs button::after { content: ''; position: absolute; left: 13px; right: 13px; bottom: 0; height: 4px; border-radius: 4px 4px 0 0; background: transparent; }
.ba-view-tabs button[data-active='true'] { color: var(--ba-blue); background: color-mix(in srgb, var(--ba-blue) 8%, transparent); }
.ba-view-tabs button[data-active='true']::after { background: var(--ba-blue); }
.ba-setup-shell {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(260px, 31%) minmax(0, 1fr);
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
}
.ba-setup-rail {
  position: relative;
  overflow: hidden;
  padding: clamp(38px, 5vw, 70px) clamp(26px, 4vw, 58px);
  color: #fff;
  border-right: 0;
  background: var(--ba-brand);
}
.ba-setup-rail::after { content: ''; position: absolute; width: 180px; height: 180px; right: -65px; bottom: -95px; border: 30px solid var(--ba-aqua); border-radius: 40px; transform: rotate(30deg); pointer-events: none; }
.ba-setup-kicker,
.ba-org-kicker { display: block; margin: 0 0 12px; color: var(--ba-blue); font: 600 10px/15px var(--ds-font-family-code); letter-spacing: .08em; }
.ba-setup-rail h3 { max-width: 360px; margin: 0; font: 750 clamp(30px, 3.5vw, 46px)/1.15 var(--ba-display); letter-spacing: -.045em; }
.ba-setup-rail > p { max-width: 400px; margin: 17px 0 0; color: #e0e5ff; font-size: 13px; line-height: 21px; }
.ba-setup-rail .ba-setup-kicker { color: #e0e5ff; }
.ba-steps { display: grid; gap: 17px; margin: 52px 0 0; padding: 0; list-style: none; }
.ba-steps li { position: relative; display: flex; align-items: center; gap: 12px; color: #e0e5ff; font-size: 12px; }
.ba-steps li:not(:last-child)::after { content: ''; position: absolute; left: 13px; top: 29px; width: 1px; height: 17px; background: var(--dsw-alias-border-l3); }
.ba-steps li > span { width: 27px; height: 27px; display: grid; place-items: center; border: 1px solid var(--dsw-alias-border-l3); border-radius: 50%; background: var(--dsw-alias-bg-layer-1); font: 600 10px/27px var(--ds-font-family-code); }
.ba-steps li > span { color: #fff; border-color: #aebaff; background: transparent; }
.ba-steps li[data-active='true'] { color: #fff; font-weight: 700; }
.ba-steps li[data-active='true'] > span { color: #1935bd; border-color: #fff; background: #fff; box-shadow: 0 0 0 5px #ffffff26; }
.ba-steps li[data-done='true'] > span { color: var(--ba-aqua); border-color: var(--ba-aqua); }
.ba-setup-content { min-width: 0; min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr) auto; overflow: hidden; }
.ba-setup-stage { width: min(820px, 100%); min-height: 0; overflow: auto; margin: 0 auto; padding: clamp(36px, 5vw, 64px) clamp(26px, 5vw, 64px) 30px; }
.ba-stage-number { margin: 0 0 8px; color: var(--ba-blue); font: 600 10px/15px var(--ds-font-family-code); letter-spacing: .08em; }
.ba-setup-stage > h3 { margin: 0; font: 650 clamp(23px, 2.6vw, 32px)/1.18 var(--dsw-font-family); letter-spacing: -.035em; }
.ba-stage-lead { max-width: 650px; margin: 10px 0 28px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 19px; }
.ba-setup-grid { display: grid; grid-template-columns: minmax(0, 1fr) 200px; gap: 17px; }
.ba-setup-grid .ba-input,
.ba-setup-grid .ba-textarea { box-sizing: border-box; height: 42px; padding: 0 12px; }
.ba-setup-grid .ba-textarea { height: auto; padding: 12px; }
.ba-mission-input { min-height: 128px; font-size: 14px; line-height: 22px; }
.ba-setup-actions { min-height: 68px; display: flex; align-items: center; justify-content: space-between; padding: 12px clamp(26px, 5vw, 64px); border-top: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.ba-setup-actions .ba-button { min-width: 96px; min-height: 38px; }
.ba-template-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
.ba-template-row button { min-height: 34px; padding: 0 13px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; color: var(--dsw-alias-label-secondary); background: transparent; font: 500 11px/17px var(--dsw-font-family); cursor: pointer; }
.ba-template-row button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ba-template-row button[data-active='true'] { color: var(--ba-blue); border-color: color-mix(in srgb, var(--ba-blue) 55%, transparent); background: color-mix(in srgb, var(--ba-blue) 8%, transparent); }
.ba-draft-list,
.ba-capability-drafts { display: grid; gap: 9px; }
.ba-member-draft,
.ba-capability-draft { position: relative; display: grid; align-items: end; gap: 8px 12px; padding: 14px 42px 14px 50px; border-bottom: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.ba-member-draft { grid-template-columns: minmax(120px, .8fr) minmax(120px, .8fr) minmax(200px, 1.6fr); }
.ba-capability-draft { grid-template-columns: minmax(150px, .8fr) minmax(260px, 1.6fr); }
.ba-member-draft:first-child,
.ba-capability-draft:first-child { border-top: 1px solid var(--dsw-alias-border-l2); }
.ba-member-draft > .ba-node-marker,
.ba-capability-draft > .ba-node-marker { position: absolute; left: 13px; top: 27px; }
.ba-member-draft label,
.ba-capability-draft label { min-width: 0; }
.ba-member-draft label > span,
.ba-capability-draft label > span { display: block; margin-bottom: 5px; color: var(--dsw-alias-label-caption); font: 9px/13px var(--ds-font-family-code); }
.ba-member-draft input,
.ba-capability-draft input { box-sizing: border-box; width: 100%; height: 33px; padding: 0; border: 0; border-bottom: 1px solid transparent; color: var(--dsw-alias-label-primary); background: transparent; font: 12px/18px var(--dsw-font-family); }
.ba-member-draft input:hover,
.ba-member-draft input:focus,
.ba-capability-draft input:hover,
.ba-capability-draft input:focus { outline: 0; border-bottom-color: var(--ba-blue); }
.ba-draft-remove { position: absolute; right: 9px; top: 23px; width: 26px; height: 26px; border: 0; border-radius: 7px; color: var(--dsw-alias-label-caption); background: transparent; cursor: pointer; }
.ba-draft-remove:hover { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover); }
.ba-draft-remove:disabled { opacity: .25; cursor: default; }
.ba-add-row { display: inline-flex; align-items: center; gap: 7px; margin-top: 13px; padding: 7px 0; border: 0; color: var(--ba-blue); background: transparent; font: 550 11px/17px var(--dsw-font-family); cursor: pointer; }
.ba-setup-summary { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 10px; align-items: center; margin-top: 25px; padding: 14px 16px; border-left: 3px solid var(--ba-orange); background: color-mix(in srgb, var(--ba-orange) 7%, var(--dsw-alias-bg-layer-2)); }
.ba-setup-summary .ba-home-type-dot { grid-row: 1 / 3; }
.ba-setup-summary strong { font-size: 12px; }
.ba-setup-summary span:last-child { color: var(--dsw-alias-label-tertiary); font-size: 10px; }
.ba-setup-location { display: grid; grid-template-columns: minmax(220px, .75fr) minmax(300px, 1.25fr); gap: 26px; align-items: start; padding: 22px; border: 1px solid color-mix(in srgb, var(--ba-purple) 24%, var(--dsw-alias-border-l2)); background: linear-gradient(115deg, color-mix(in srgb, var(--ba-purple) 5%, transparent), transparent 44%), var(--dsw-alias-bg-layer-1); }
.ba-setup-location .ba-select { width: 100%; height: 40px; }
.ba-setup-location code { display: block; overflow: hidden; margin-top: 7px; color: var(--dsw-alias-label-caption); font: 9px/14px var(--ds-font-family-code); text-overflow: ellipsis; white-space: nowrap; }
.ba-location-note { margin: 13px 0 0; color: var(--dsw-alias-label-caption); font-size: 9px; line-height: 15px; }
.ba-location-empty { padding: 22px; border: 1px dashed var(--dsw-alias-border-l3); color: var(--dsw-alias-label-tertiary); text-align: center; font-size: 11px; }
.ba-node-marker { width: 24px; height: 24px; flex: 0 0 24px; display: inline-grid; place-items: center; border-radius: 8px; color: #fff; background: var(--ba-blue); font: 650 9px/24px var(--ds-font-family-code); }
.ba-node-marker[data-type='business'] { background: var(--ba-orange); }
.ba-node-marker[data-type='line'] { background: var(--ba-blue); }
.ba-node-marker[data-type='line']::after { content: 'L'; }
.ba-node-marker[data-type='role'] { background: var(--ba-purple); }
.ba-node-marker[data-type='capability'] { background: var(--ba-cyan); }
.ba-node-marker[data-type='capability']::after { content: '◇'; font-size: 13px; }
.ba-node-marker[data-type='business']::after { content: 'B'; }
.ba-org-shell { min-height: 0; overflow: auto; padding: 24px clamp(20px, 3.5vw, 52px) 42px; background: var(--dsw-alias-bg-base); }
.ba-org-hero { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 24px; align-items: center; max-width: 1180px; margin: 0 auto; padding: 32px 42px; overflow: hidden; border-radius: 22px; color: #fff; background: var(--ba-brand); }
.ba-org-intro { position: relative; min-width: 0; z-index: 1; }
.ba-org-hero .ba-org-kicker { color: #d5ddff; font: 600 12px/18px var(--ba-display); letter-spacing: 0; margin-bottom: 12px; }
.ba-org-hero h3 { margin: 0; font: 750 clamp(36px, 4.5vw, 64px)/1.12 var(--ba-display); letter-spacing: -.05em; overflow-wrap: anywhere; }
.ba-org-hero > div > p:not(.ba-org-kicker) { max-width: 600px; margin: 12px 0 0; color: #e0e5ff; font-size: 14px; line-height: 23px; }
.ba-hero-action { margin-top: 22px; min-height: 42px; padding: 0 18px; color: #1833ad; background: #fff; border-color: #fff; border-radius: 10px; font-weight: 700; }
.ba-hero-action:hover { color: #1833ad; background: #e8edff; border-color: #e8edff; }
.ba-org-metrics { display: flex; flex-wrap: wrap; gap: 14px 28px; margin-top: 22px; color: #e0e5ff; font-size: 11px; }
.ba-org-metrics span { display: grid; gap: 3px; }
.ba-org-metrics strong { color: #fff; font: 750 27px/30px var(--ba-display); }
.ba-org-art { position: relative; display: grid; place-items: center; width: 260px; height: 260px; isolation: isolate; }
.ba-org-art::before, .ba-org-art::after { content: ''; position: absolute; inset: 12px; border: 1px solid #a9baff66; border-radius: 50%; transform: rotate(-26deg) scaleX(1.2) scaleY(.7); z-index: -1; }
.ba-org-art::after { inset: -12px; transform: rotate(32deg) scaleX(.8); border-color: #a9baff3d; }
.ba-org-art .ba-mark { width: 200px; height: 200px; transform: rotate(-12deg); filter: drop-shadow(12px 20px 0 #122ba833); transition: transform 240ms ease; }
.ba-org-hero:hover .ba-org-art .ba-mark { transform: rotate(-6deg) translateY(-5px); }
.ba-organization-location { max-width: 1120px; margin: 34px auto 0; padding: 20px; border-top: 1px solid color-mix(in srgb, var(--ba-purple) 42%, var(--dsw-alias-border-l2)); border-bottom: 1px solid var(--dsw-alias-border-l2); background: linear-gradient(105deg, color-mix(in srgb, var(--ba-purple) 5%, transparent), transparent 46%); }
.ba-location-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 16px; }
.ba-location-heading .ba-org-kicker { margin-bottom: 3px; color: var(--ba-purple); }
.ba-location-heading h4 { margin: 0; font: 630 16px/22px var(--dsw-font-family); }
.ba-location-heading > p { max-width: 510px; margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 10px; line-height: 16px; text-align: right; }
.ba-location-content { display: grid; grid-template-columns: minmax(320px, .9fr) minmax(280px, 1.1fr); gap: 30px; align-items: center; padding: 18px 20px; border-left: 3px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); }
.ba-location-content[data-current='true'] { border-left-color: var(--ba-purple); }
.ba-path-tree { display: grid; gap: 2px; }
.ba-path-tree > div { position: relative; min-width: 0; display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; align-items: center; gap: 9px; min-height: 31px; padding-left: calc(var(--ba-tree-level, 0) * 24px); }
.ba-path-tree > div[data-level='0'] { --ba-tree-level: 0; }
.ba-path-tree > div[data-level='1'] { --ba-tree-level: 1; }
.ba-path-tree > div[data-level='2'] { --ba-tree-level: 2; }
.ba-path-tree > div[data-level='1']::before,
.ba-path-tree > div[data-level='2']::before { content: ''; position: absolute; left: calc((var(--ba-tree-level) * 24px) - 13px); top: -3px; width: 13px; height: 19px; border-left: 1px solid var(--dsw-alias-border-l3); border-bottom: 1px solid var(--dsw-alias-border-l3); }
.ba-path-tree strong { overflow: hidden; font: 600 11px/17px var(--ds-font-family-code); text-overflow: ellipsis; white-space: nowrap; }
.ba-path-tree small { color: var(--dsw-alias-label-caption); font: 9px/14px var(--dsw-font-family); }
.ba-folder-mark { position: relative; width: 16px; height: 12px; border: 1.5px solid var(--ba-blue); border-radius: 2px; }
.ba-folder-mark::before { content: ''; position: absolute; left: 1px; top: -4px; width: 7px; height: 4px; border: 1.5px solid var(--ba-blue); border-bottom: 0; border-radius: 2px 2px 0 0; }
.ba-folder-mark[data-active='true'],
.ba-folder-mark[data-active='true']::before { border-color: var(--ba-purple); }
.ba-location-facts { min-width: 0; display: grid; gap: 8px; padding-left: 22px; border-left: 1px solid var(--dsw-alias-border-l2); }
.ba-location-facts span { color: var(--ba-purple); font: 600 9px/14px var(--ds-font-family-code); letter-spacing: .06em; text-transform: uppercase; }
.ba-location-facts code { overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); font: 10px/17px var(--ds-font-family-code); }
.ba-sample-offer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px; margin: 0 0 30px; padding: 16px 18px; border: 1px solid var(--dsw-alias-border-l2, #dfe3ef); border-radius: 12px; background: var(--dsw-alias-bg-l1, #f6f7fb); }
.ba-sample-offer > div { flex: 1 1 320px; min-width: 0; }
.ba-sample-offer strong { display: block; font-size: 15px; }
.ba-sample-offer p { margin: 4px 0 0; color: var(--dsw-alias-text-l2, #5b6170); font-size: 13px; line-height: 1.5; }
.ba-sample-offer .ba-inline-error { flex-basis: 100%; }
.ba-sample-guide { max-width: 1120px; margin: 22px auto 0; padding: 22px 24px; border: 1px solid var(--dsw-alias-border-l2, #dfe3ef); border-radius: 16px; background: var(--dsw-alias-bg-base, #fff); }
.ba-sample-guide-head h3 { margin: 0; font-size: 18px; }
.ba-sample-guide-head p { margin: 6px 0 0; color: var(--dsw-alias-text-l2, #5b6170); font-size: 13px; }
.ba-sample-steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin: 18px 0 0; padding: 0; list-style: none; }
.ba-sample-step { display: flex; gap: 10px; min-width: 0; padding: 14px; border-radius: 12px; background: var(--dsw-alias-bg-l1, #f6f7fb); }
.ba-sample-index { flex: none; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: #2e4be6; color: #fff; font-size: 12px; font-weight: 650; }
.ba-sample-body { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.ba-sample-prompt { margin: 0; padding: 8px 10px; border-left: 3px solid #2e4be6; background: var(--dsw-alias-bg-base, #fff); font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }
.ba-sample-after { margin: 0; color: var(--dsw-alias-text-l2, #5b6170); font-size: 12px; line-height: 1.5; }
.ba-sample-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: auto; }
.ba-org-map { position: relative; max-width: 1120px; margin: 26px auto 0; padding: 0 0 14px; }
.ba-business-node { box-sizing: border-box; width: min(420px, 72%); display: flex; align-items: center; gap: 13px; margin: 0 auto; padding: 16px 20px; border: 1px solid #ffa18a; border-radius: 14px; color: #692a19; background: #ffdbc9; text-align: left; cursor: pointer; }
.ba-business-node:hover { background: #ffcbb5; }
.ba-line-node { border-color: color-mix(in srgb, var(--ba-blue) 50%, white); color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--ba-blue) 12%, var(--dsw-alias-bg-layer-1)); }
.ba-line-node:hover { background: color-mix(in srgb, var(--ba-blue) 20%, var(--dsw-alias-bg-layer-1)); }
.ba-business-node > div { min-width: 0; display: grid; }
.ba-business-node small { color: #803d28; font: 600 11px/16px var(--ba-display); }
.ba-business-node strong { font: 700 17px/25px var(--ba-display); }
.ba-business-node code,
.ba-org-member code,
.ba-capability-rail code { overflow: hidden; color: var(--dsw-alias-label-caption); font: 9px/14px var(--ds-font-family-code); text-overflow: ellipsis; white-space: nowrap; }
.ba-business-node code { color: #803d28; }
.ba-map-trunk { display: block; width: 1px; height: 34px; margin: 0 auto; background: linear-gradient(var(--ba-orange), var(--dsw-alias-border-l3)); }
.ba-member-nodes { position: relative; display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; padding-top: 18px; border-top: 1px solid var(--dsw-alias-border-l3); }
.ba-org-member { position: relative; min-width: 0; display: flex; align-items: flex-start; gap: 13px; padding: 18px; border: 1px solid color-mix(in srgb, var(--ba-blue) 25%, var(--dsw-alias-border-l2)); border-top: 4px solid var(--ba-blue); border-radius: 14px; color: inherit; background: color-mix(in srgb, var(--ba-blue) 4%, var(--dsw-alias-bg-layer-1)); text-align: left; cursor: pointer; }
.ba-org-member::before { content: ''; position: absolute; width: 1px; height: 19px; left: 50%; top: -19px; background: var(--dsw-alias-border-l3); }
.ba-org-member:hover { border-color: color-mix(in srgb, var(--ba-blue) 42%, var(--dsw-alias-border-l3)); box-shadow: 0 7px 20px rgba(10,18,35,.07); transform: translateY(-1px); }
.ba-org-member-copy { min-width: 0; flex: 1; display: grid; }
.ba-org-member-copy strong { font: 700 16px/23px var(--ba-display); }
.ba-org-member-copy > span { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 19px; }
.ba-role-ribbon { position: absolute; right: 10px; bottom: -9px; display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px 2px 3px; border: 1px solid color-mix(in srgb, var(--ba-purple) 26%, var(--dsw-alias-border-l2)); border-radius: 999px; color: var(--ba-purple); background: var(--dsw-alias-bg-layer-1); font-size: 8px; }
.ba-role-ribbon .ba-node-marker { width: 14px; height: 14px; border-radius: 50%; }
.ba-capability-rail { display: flex; flex-wrap: wrap; align-items: stretch; gap: 8px; margin-top: 28px; padding: 13px; border: 1px solid color-mix(in srgb, var(--ba-cyan) 42%, var(--dsw-alias-border-l3)); border-radius: 14px; background: color-mix(in srgb, var(--ba-cyan) 9%, var(--dsw-alias-bg-layer-1)); }
.ba-capability-label { display: grid; place-items: center; padding: 0 9px; color: var(--dsw-alias-label-secondary); font: 650 12px/18px var(--ba-display); }
.ba-capability-rail button { min-width: 160px; flex: 1; display: flex; align-items: center; gap: 9px; padding: 8px 10px; border: 0; border-left: 1px solid var(--dsw-alias-border-l2); color: inherit; background: transparent; text-align: left; cursor: pointer; }
.ba-capability-rail button:hover { background: color-mix(in srgb, var(--ba-cyan) 8%, transparent); }
.ba-capability-rail button > span:last-child { min-width: 0; display: grid; }
.ba-capability-rail strong { font: 650 13px/20px var(--ba-display); }
.ba-org-next { max-width: 1120px; display: grid; grid-template-columns: repeat(3, 1fr); margin: 24px auto 0; border-top: 1px solid var(--dsw-alias-border-l2); border-bottom: 1px solid var(--dsw-alias-border-l2); }
.ba-org-next > div { display: flex; gap: 11px; padding: 17px 18px 17px 0; }
.ba-org-next > div + div { padding-left: 18px; border-left: 1px solid var(--dsw-alias-border-l2); }
.ba-org-next > div > span { width: 22px; height: 22px; flex: 0 0 22px; display: grid; place-items: center; border-radius: 50%; color: var(--ba-blue); background: color-mix(in srgb, var(--ba-blue) 9%, transparent); font: 600 9px/22px var(--ds-font-family-code); }
.ba-org-next p { display: grid; gap: 3px; margin: 0; color: var(--dsw-alias-label-caption); font-size: 9px; line-height: 14px; }
.ba-org-next strong { color: var(--dsw-alias-label-secondary); font-size: 10px; }
.ba-unassigned { max-width: 1120px; margin: 13px auto 0; color: var(--dsw-alias-label-caption); font-size: 9px; }
@media (max-width: 1120px) {
  .ba-body { grid-template-columns: 220px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; }
  .ba-directory { grid-row: 1 / 3; }
  .ba-proposals { max-height: 300px; border-left: 0; border-top: 1px solid var(--dsw-alias-border-l2); }
  .ba-proposal-list { display: grid; grid-template-columns: repeat(2, minmax(240px, 1fr)); gap: 9px; }
  .ba-proposal-card { margin: 0; }
  .ba-member-draft { grid-template-columns: repeat(2, minmax(130px, 1fr)); }
  .ba-member-draft .ba-draft-wide { grid-column: 1 / -1; }
  .ba-location-content { grid-template-columns: minmax(280px, .9fr) minmax(250px, 1.1fr); }
}
@media (max-width: 760px) {
  .ba-overlay { padding: 0; }
  .ba-dialog { width: 100%; height: 100%; min-height: 0; border: 0; border-radius: 0; }
  .ba-topbar { min-height: 64px; gap: 8px; padding: 10px 12px; }
  .ba-brand-sigil { display: none; }
  .ba-subtitle, .ba-health, .ba-current-location { display: none; }
  .ba-title-wrap { flex: 0 1 auto; }
  .ba-title { font-size: 21px; line-height: 27px; }
  .ba-top-actions { gap: 2px; }
  .ba-top-actions .ba-icon-button { width: 30px; height: 34px; }
  .ba-view-tabs { flex: 1; justify-content: center; margin-right: 0; }
  .ba-view-tabs button { min-width: 50px; padding: 0 7px; }
  .ba-body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) auto; }
  .ba-directory { position: relative; grid-row: auto; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
  .ba-directory .ba-pane-head { min-height: 43px; padding: 10px 54px 8px 12px; }
  .ba-create-button { position: absolute; right: 12px; top: 7px; width: 32px; min-height: 30px; margin: 0; border-style: solid; font-size: 0; }
  .ba-home-list { display: flex; gap: 6px; overflow-x: auto; max-width: 100%; padding: 5px 9px 10px; }
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
  .ba-setup-shell { display: block; overflow: auto; }
  .ba-setup-rail { padding: 25px 22px 18px; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
  .ba-setup-rail h3 { font-size: 25px; }
  .ba-setup-rail > p { margin-top: 10px; }
  .ba-steps { grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 20px; }
  .ba-steps li { gap: 6px; font-size: 9px; }
  .ba-steps li:not(:last-child)::after { display: none; }
  .ba-setup-content { overflow: visible; }
  .ba-setup-stage { overflow: visible; padding: 28px 18px 20px; }
  .ba-setup-grid,
  .ba-member-draft,
  .ba-capability-draft { grid-template-columns: 1fr; }
  .ba-member-draft .ba-draft-wide { grid-column: auto; }
  .ba-setup-location { grid-template-columns: 1fr; }
  .ba-setup-actions { position: sticky; bottom: 0; padding: 10px 18px; }
  .ba-org-shell { padding: 16px 14px 28px; }
  .ba-org-hero { grid-template-columns: minmax(0, 1fr); padding: 26px 24px; border-radius: 18px; }
  .ba-org-hero h3 { max-width: 100%; font-size: 39px; }
  .ba-org-art { display: none; }
  .ba-hero-action { width: 100%; }
  .ba-org-metrics { gap: 20px; }
  .ba-location-heading { display: block; }
  .ba-location-heading > p { margin-top: 7px; text-align: left; }
  .ba-location-content { grid-template-columns: 1fr; gap: 18px; }
  .ba-location-facts { padding: 14px 0 0; border-left: 0; border-top: 1px solid var(--dsw-alias-border-l2); }
  .ba-member-nodes { grid-template-columns: 1fr; border-top: 0; padding-top: 0; }
  .ba-map-trunk,
  .ba-org-member::before { display: none; }
  .ba-business-node { width: auto; margin-bottom: 13px; }
  .ba-org-next { grid-template-columns: 1fr; }
  .ba-org-next > div + div { padding-left: 0; border-left: 0; border-top: 1px solid var(--dsw-alias-border-l2); }
}
.ba-subscription-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding-top: 4px; }
.ba-projects-shell { min-height: 0; overflow: auto; padding: 30px clamp(18px, 3.5vw, 48px) 54px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }
.ba-projects-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; max-width: 1350px; margin: 0 auto 24px; }
.ba-projects-heading h3 { margin: 0; font: 750 clamp(27px, 2.8vw, 38px)/1.12 var(--ba-display); letter-spacing: -.045em; }
.ba-projects-heading p { margin: 8px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 19px; }
.ba-projects-heading-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.ba-projects-layout { display: grid; grid-template-columns: minmax(260px, 360px) minmax(0, 1fr); max-width: 1350px; min-height: 500px; margin: auto; border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.ba-projects-directory { display: flex; flex-direction: column; min-width: 0; border-right: 1px solid var(--dsw-alias-border-l2); }
.ba-projects-directory-head { display: flex; justify-content: space-between; padding: 18px 19px 12px; font-size: 14px; }
.ba-projects-directory-head span { color: var(--dsw-alias-label-caption); font: 12px var(--ds-font-family-code); }
.ba-projects-filter { display: flex; gap: 8px; align-items: center; padding: 0 19px 14px; color: var(--dsw-alias-label-secondary); font-size: 12px; cursor: pointer; }
.ba-projects-filter input { accent-color: var(--ba-brand); }
.ba-projects-list { display: grid; align-content: start; }
.ba-projects-row { display: grid; gap: 7px; width: 100%; padding: 15px 19px; border: 0; border-top: 1px solid var(--dsw-alias-border-l2); border-left: 3px solid transparent; text-align: left; color: inherit; background: transparent; cursor: pointer; }
.ba-projects-row:hover { background: var(--dsw-alias-bg-layer-2); }
.ba-projects-row[data-selected='true'] { border-left-color: var(--ba-brand); background: color-mix(in srgb, var(--ba-brand) 7%, var(--dsw-alias-bg-layer-1)); }
.ba-projects-row-top { display: flex; align-items: start; justify-content: space-between; gap: 8px; }
.ba-projects-row-top strong { font-size: 13px; line-height: 19px; }
.ba-projects-row-goal { display: -webkit-box; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.ba-projects-row small { overflow: hidden; color: var(--dsw-alias-label-caption); text-overflow: ellipsis; white-space: nowrap; }
.ba-projects-status { flex: 0 0 auto; padding: 3px 7px; border-radius: 5px; color: #3155a1; background: #e8efff; font-size: 11px; font-weight: 650; white-space: nowrap; }
.ba-projects-status[data-status='review'] { color: #8a541c; background: #fff0d6; }
.ba-projects-status[data-status='accepted'] { color: #167b72; background: #def8f1; }
.ba-projects-more { align-self: center; margin: 18px; }
.ba-projects-detail { min-width: 0; padding: 28px clamp(20px, 3vw, 46px) 52px; }
.ba-projects-empty { margin: 20px; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.ba-projects-detail-head { display: flex; justify-content: space-between; gap: 14px; align-items: start; }
.ba-projects-detail-head h4 { margin: 10px 0 5px; font: 750 clamp(22px, 2.4vw, 31px)/1.2 var(--ba-display); letter-spacing: -.035em; }
.ba-projects-detail-head code, .ba-projects-revision { color: var(--dsw-alias-label-caption); font: 11px/17px var(--ds-font-family-code); }
.ba-projects-brief { display: grid; gap: 13px; margin: 25px 0 0; }
.ba-projects-brief div { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 14px; }
.ba-projects-brief dt { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.ba-projects-brief dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 20px; }
.ba-projects-section { margin-top: 32px; padding-top: 23px; border-top: 1px solid var(--dsw-alias-border-l2); }
.ba-projects-section h5 { margin: 0 0 16px; font-size: 16px; }
.ba-projects-section > p { color: var(--dsw-alias-label-secondary); font-size: 13px; }
.ba-projects-section-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
.ba-projects-section-head span { color: var(--dsw-alias-label-caption); font-size: 11px; }
.ba-projects-inbox { padding: 24px; }
.ba-projects-inbox h4 { margin: 0 0 8px; font-size: 18px; }
.ba-projects-inbox > p { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.ba-projects-inbox-list { display: grid; gap: 14px; margin: 18px 0; }
.ba-projects-inbox-card { display: grid; gap: 8px; padding: 18px 20px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.ba-projects-inbox-card p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 19px; }
.ba-projects-inbox-card small { color: var(--dsw-alias-label-caption); overflow-wrap: anywhere; }
.ba-projects-inbox-card ul { margin: 0; padding-left: 18px; font-size: 12px; }
.ba-projects-inbox-card label { display: grid; gap: 6px; max-width: 650px; font-size: 12px; }
.ba-projects-inbox-card textarea { min-height: 75px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font: 13px/20px var(--dsw-font-family); resize: vertical; }
.ba-projects-inbox-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.ba-projects-work, .ba-projects-seats { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.ba-projects-work li, .ba-projects-seats li { display: flex; flex-wrap: wrap; gap: 8px 15px; align-items: baseline; font-size: 12px; }
.ba-projects-work small, .ba-projects-seats small { color: var(--dsw-alias-label-caption); }
.ba-projects-claim > p { white-space: pre-wrap; line-height: 20px; }
.ba-projects-claim > .ba-markdown { margin-top: 10px; }
.ba-projects-claim small { color: var(--dsw-alias-label-secondary); }
.ba-projects-claim-evidence { display: grid; gap: 6px; margin: 12px 0; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); font-size: 12px; }
.ba-projects-claim-evidence p { margin: 0; white-space: pre-wrap; line-height: 19px; }
.ba-projects-claim-evidence ul { display: grid; gap: 5px; margin: 4px 0 0; padding-left: 18px; overflow-wrap: anywhere; }
.ba-projects-human-review { display: grid; gap: 10px; margin-top: 15px; max-width: 650px; }
.ba-projects-human-review label { display: grid; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ba-projects-human-review textarea { min-height: 70px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font: 13px/20px var(--dsw-font-family); resize: vertical; }
.ba-projects-human-review > div { display: flex; flex-wrap: wrap; gap: 8px; }
@media (max-width: 760px) { .ba-projects-layout { display: block; } .ba-projects-directory { border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); } .ba-projects-list { max-height: 260px; overflow: auto; } .ba-projects-heading { align-items: start; } }
@media (max-width: 600px) { .ba-topbar { flex-wrap: wrap; } .ba-top-actions { margin-left: auto; } .ba-view-tabs { order: 3; flex: 0 0 calc(100% + 24px); height: 42px; justify-content: flex-start; overflow-x: auto; margin: 0 -12px -10px; padding: 0 12px; } .ba-view-tabs button { flex: 0 0 auto; }           }
.ba-pulse-header { display: flex; justify-content: space-between; align-items: end; gap: 24px; border-bottom: 1px solid var(--dsw-alias-border-l2); padding-bottom: 23px; }
.ba-pulse-eyebrow { margin: 0 0 7px; color: var(--ba-blue); font: 700 11px/1.4 var(--ds-font-family-code); letter-spacing: .13em; text-transform: uppercase; }
.ba-pulse-header h3 { margin: 0; font: 750 clamp(28px, 3vw, 42px)/1.05 var(--ba-display); letter-spacing: -.045em; }
.ba-pulse-header p:last-child { margin: 8px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.ba-pulse-quiet { min-height: 34px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; color: var(--dsw-alias-label-primary); background: transparent; font: 650 11px var(--ba-display); }
.ba-pulse-quiet:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ba-pulse-error { margin: 12px 0 0; padding: 10px 13px; border-left: 3px solid var(--ba-orange); color: var(--ba-orange); background: color-mix(in srgb, var(--ba-orange) 8%, transparent); font-size: 12px; }
.ba-pulse-empty { padding: 45px 20px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
@media (max-width: 1000px) { .ba-pulse-header { align-items: start; flex-direction: column; } }
@media (prefers-reduced-motion: reduce) {
  .ba-overlay, .ba-dialog, .ba-asset-detail, .ba-loading-strata span { animation: none !important; }
  .ba-launcher, .ba-asset-description, .ba-org-art .ba-mark { transition: none; }
  .ba-launcher:hover, .ba-org-hero:hover .ba-org-art .ba-mark { transform: none; }
}
.ba-inbox-page { padding: 32px 40px 60px; color: var(--dsw-alias-label-primary); }
.ba-inbox-filters { display: flex; align-items: center; gap: 10px; margin: 20px 0 15px; }
.ba-inbox-filters button { padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: 650 11px var(--ba-display); }
.ba-inbox-filters button[data-active='true'] { border-color: var(--ba-brand); color: var(--ba-brand); }
.ba-inbox-filters label { margin-left: auto; font: 11px var(--ba-display); color: var(--dsw-alias-label-secondary); }
.ba-inbox-layout { display: grid; grid-template-columns: minmax(230px, 0.85fr) minmax(0, 1.5fr); min-height: 460px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.ba-inbox-list { min-width: 0; border-right: 1px solid var(--dsw-alias-border-l2); }
.ba-inbox-list > p { padding: 20px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ba-inbox-list > button { display: grid; width: 100%; gap: 6px; padding: 14px 17px; border: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); background: transparent; text-align: left; color: var(--dsw-alias-label-primary); }
.ba-inbox-list > button[data-active='true'], .ba-inbox-list > button:hover { background: color-mix(in srgb, var(--ba-blue) 7%, transparent); }
.ba-inbox-list > button strong { font: 700 12px var(--ba-display); }
.ba-inbox-list > button span, .ba-inbox-list > button small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary); font: 10px var(--ba-display); }
.ba-inbox-list > button.ba-inbox-more { justify-items: center; color: var(--ba-brand); }
.ba-inbox-detail { min-width: 0; padding: 26px; }
.ba-inbox-detail h4 { margin: 0 0 8px; font: 750 21px var(--ba-display); }
.ba-inbox-detail > p { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ba-inbox-meta { margin: 5px 0; color: var(--dsw-alias-label-tertiary) !important; font-size: 11px !important; }
.ba-inbox-action { margin: 20px 0; padding: 15px; border-left: 3px solid var(--ba-brand); background: color-mix(in srgb, var(--ba-blue) 5%, transparent); font-size: 12px; }
.ba-inbox-action strong { font: 700 12px var(--ba-display); }.ba-inbox-action p { margin: 7px 0; line-height: 1.6; }.ba-inbox-action a { color: var(--ba-brand); }
.ba-inbox-body { margin: 20px 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.8 var(--ba-display); }
.ba-inbox-detail > button, .ba-inbox-reply button { padding: 8px 12px; border: 1px solid var(--ba-brand); border-radius: 6px; background: var(--ba-brand); color: white; font: 650 11px var(--ba-display); }
.ba-inbox-reply { display: grid; gap: 11px; margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--dsw-alias-border-l2); }
.ba-inbox-reply h5 { margin: 0; font: 700 15px var(--ba-display); }
.ba-inbox-reply label { display: grid; gap: 5px; font: 11px var(--ba-display); }
.ba-inbox-reply input, .ba-inbox-reply textarea { width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 5px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: 12px var(--ba-display); }
.ba-inbox-reply button { justify-self: start; }
@media (max-width: 760px) { .ba-inbox-page { padding: 20px 14px 45px; }.ba-inbox-layout { grid-template-columns: 1fr; }.ba-inbox-list { border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); max-height: 250px; overflow: auto; } }
.ba-markdown, .ba-markdown p, .ba-markdown li { white-space: normal; overflow-wrap: anywhere; }
@keyframes ba-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes ba-rise { from { opacity: 0; transform: translateY(10px) scale(.99); } to { opacity: 1; transform: none; } }
@keyframes ba-detail { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
@keyframes ba-pulse { from { opacity: .25; transform: scaleX(.72); transform-origin: left; } to { opacity: .9; transform: scaleX(1); transform-origin: left; } }
`
