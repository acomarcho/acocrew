// Mock data only. Nothing here talks to a server.

export type Status = 'working' | 'needs' | 'done';
export type Tool = { kind: 'run' | 'edit'; label: string; detail: string };
export type Msg = { id: string; by: string; at: string; text: string; tools?: Tool[] };
export type Thread = {
  id: string;
  channelId: string;
  title: string;
  branch: string; // each thread gets its own worktree on this branch
  status: Status;
  model: string;
  effort: string;
  msgs: Msg[];
};
export type Channel = { id: string; name: string; repo: string; about: string; color: string };

export const ME = 'marcho';

export const USERS: Record<string, { name: string; color: string; agent?: boolean }> = {
  marcho: { name: 'Marcho', color: '#6366f1' },
  raymond: { name: 'Raymond', color: '#0ea5e9' },
  mike: { name: 'Mike', color: '#e11d48' },
  sam: { name: 'Sam', color: '#f59e0b' },
  jordan: { name: 'Jordan', color: '#10b981' },
  claude: { name: 'Claude', color: '#d97757', agent: true },
};

export const MODELS = [
  { name: 'Claude Opus 5.5', hint: 'Most capable' },
  { name: 'Claude Sonnet 5.5', hint: 'Balanced' },
  { name: 'Claude Haiku 4.5', hint: 'Fastest' },
];

export const EFFORTS = [
  { name: 'Low', hint: 'Quick answers' },
  { name: 'Medium', hint: 'Everyday work' },
  { name: 'High', hint: 'Thinks harder' },
  { name: 'Max', hint: 'Slowest, most careful' },
];

// A channel is one git repository.
export const CHANNELS: Channel[] = [
  { id: 'monorepo', name: 'monorepo', repo: 'opencase/monorepo', about: 'Main product: web app and API', color: '#7c5cff' },
  { id: 'mobile-app', name: 'mobile-app', repo: 'opencase/mobile-app', about: 'iOS and Android app', color: '#0ea5e9' },
  { id: 'landing-site', name: 'landing-site', repo: 'opencase/landing-site', about: 'Marketing website', color: '#10b981' },
  { id: 'data-pipelines', name: 'data-pipelines', repo: 'opencase/data-pipelines', about: 'Reports and scheduled jobs', color: '#e11d48' },
  { id: 'infra', name: 'infra', repo: 'opencase/infra', about: 'Servers and deploys', color: '#f59e0b' },
];

let n = 0;
const m = (by: string, at: string, text: string, tools?: Tool[]): Msg => ({ id: `m${++n}`, by, at, text, tools });
const t = (
  channelId: string,
  title: string,
  branch: string,
  status: Status,
  msgs: Msg[],
  model = 'Claude Opus 5.5',
  effort = 'High',
): Thread => ({ id: `t${++n}`, channelId, title, branch: `thread/${branch}`, status, model, effort, msgs });

export const SEED: Thread[] = [
  t('monorepo', 'Why is the dashboard slow for big accounts?', 'dashboard-slow', 'done', [
    m('mike', 'Yesterday 2:10 PM', 'Why is the dashboard slow for big accounts? A customer with about 4,000 claims says it takes 20 seconds to load.'),
    m('claude', 'Yesterday 2:14 PM', 'Found it. The dashboard loads every claim one by one instead of in a single request. I changed it to load them together and added a test. For a 4,000 claim account it now loads in about 1 second.', [
      { kind: 'run', label: 'Ran', detail: 'pnpm test dashboard' },
      { kind: 'edit', label: 'Edited', detail: 'apps/web/src/dashboard/loadClaims.ts' },
    ]),
    m('mike', 'Yesterday 2:20 PM', 'Amazing, thank you.'),
  ], 'Claude Sonnet 5.5', 'Medium'),
  t('monorepo', 'Emails stopped going out since yesterday', 'emails-stopped', 'done', [
    m('marcho', 'Yesterday 7:35 PM', 'Emails stopped going out since yesterday. Morning briefings did not arrive for anyone. Can you find out why and fix it?'),
    m('claude', 'Yesterday 7:41 PM', 'All 159 runs today failed at the same step. The Gmail quota was hit, and the retry logic kept retrying instantly, which made it worse. I made retries wait longer each time and opened a pull request.', [
      { kind: 'run', label: 'Ran', detail: 'grep -r "Quota exceeded" logs/' },
      { kind: 'edit', label: 'Edited', detail: 'services/associate/retry.ts' },
      { kind: 'run', label: 'Ran', detail: 'gh pr create --title "Back off on Gmail quota errors"' },
    ]),
    m('raymond', 'Yesterday 7:50 PM', 'Will the failed emails be sent again once this is merged?'),
    m('claude', 'Yesterday 7:51 PM', 'Yes. The failed runs are still in the queue, so they will retry on their own after the merge.'),
    m('marcho', 'Yesterday 7:54 PM', 'Fix is merged. The failed emails should retry.'),
  ]),
  t('monorepo', "Change the signup button to say 'Start free trial'", 'signup-button-text', 'needs', [
    m('sam', '9:02 AM', "Change the signup button to say 'Start free trial' instead of 'Sign up'."),
    m('claude', '9:03 AM', 'There are two signup buttons: one in the top bar and one on the pricing page. Should I change both, or only the one in the top bar?', [
      { kind: 'run', label: 'Ran', detail: 'grep -rn "Sign up" apps/web/src' },
    ]),
  ], 'Claude Haiku 4.5', 'Low'),
  t('monorepo', 'Add an Export to CSV button on the claims table', 'claims-csv-export', 'working', [
    m('raymond', '9:28 AM', 'Add an Export to CSV button on the claims table. It should export whatever filters are currently applied.'),
    m('jordan', '9:30 AM', 'Please include the claim owner column too, finance asked for it.'),
  ]),
  t('mobile-app', 'App crashes when opening a notification', 'notification-crash', 'working', [
    m('jordan', '8:47 AM', 'The app crashes when I open a notification while the app is closed. Happens every time on my iPhone.'),
  ]),
  t('mobile-app', 'Add a dark mode toggle in settings', 'dark-mode-toggle', 'done', [
    m('sam', 'Yesterday 11:05 AM', 'Add a dark mode toggle in settings.'),
    m('claude', 'Yesterday 11:19 AM', 'Done. There is a new Appearance row in Settings with Light, Dark and System. It remembers the choice after restart.', [
      { kind: 'edit', label: 'Edited', detail: 'src/screens/Settings.tsx' },
      { kind: 'edit', label: 'Edited', detail: 'src/theme/useTheme.ts' },
    ]),
  ], 'Claude Sonnet 5.5', 'Medium'),
  t('landing-site', 'Fix the typo in the footer', 'footer-typo', 'done', [
    m('mike', 'Yesterday 4:40 PM', 'The footer says "All rights reservd". Please fix.'),
    m('claude', 'Yesterday 4:41 PM', 'Fixed. It now says "All rights reserved".', [{ kind: 'edit', label: 'Edited', detail: 'src/components/Footer.astro' }]),
  ], 'Claude Haiku 4.5', 'Low'),
  t('landing-site', 'Update the pricing page with the new Team plan', 'pricing-team-plan', 'needs', [
    m('jordan', '10:12 AM', 'Update the pricing page with the new Team plan. $49 per seat, sits between Starter and Enterprise.'),
    m('claude', '10:15 AM', 'I added the Team plan card. I need the list of features to show on it. Can you paste them, or should I copy the Starter list and add "Shared threads"?', [
      { kind: 'edit', label: 'Edited', detail: 'src/pages/pricing.astro' },
    ]),
  ]),
  t('data-pipelines', "Daily token report is missing yesterday's numbers", 'token-report-gap', 'needs', [
    m('raymond', '9:04 AM', "The daily token report is missing yesterday's numbers. The row is there but everything is zero."),
    m('claude', '9:09 AM', 'The job ran before the usage data arrived, so it saw nothing. I can rerun it for yesterday now. That will overwrite the zero row. OK to go ahead?', [
      { kind: 'run', label: 'Ran', detail: 'python jobs/token_ledger.py --dry-run --date yesterday' },
    ]),
  ]),
  t('infra', 'Disk on the jobs VM is 91% full', 'jobs-vm-disk', 'done', [
    m('sam', 'Yesterday 9:09 AM', 'Disk on the jobs VM is 91% full and scheduled jobs are failing. What can we safely delete?'),
    m('claude', 'Yesterday 9:16 AM', 'Old job logs were taking 14 GB. I deleted logs older than 30 days and the disk is now at 62%. I also added a weekly cleanup so it does not fill up again.', [
      { kind: 'run', label: 'Ran', detail: 'du -sh /var/log/scheduled-agents/*' },
      { kind: 'edit', label: 'Edited', detail: 'scripts/scheduled-disk-check.sh' },
    ]),
    m('sam', 'Yesterday 9:20 AM', 'Jobs are green again. Thanks!'),
  ], 'Claude Sonnet 5.5', 'High'),
];
