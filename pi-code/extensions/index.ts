// Homelab extensions for pi, loaded from ~/.pi/agent/extensions/homelab
// (install.sh symlinks this directory there). pi auto-discovers index.ts; the
// other files are modules, not separate extensions.
//
//   arbiter-provider  provider "arbiter", model "default" (the local GPU)
//   bash-classifier   tool_call gate: every non-trivial bash command is judged
//   advisor           ask_advisor tool + /advisor command (second opinion)
//   web-search        web_search (Brave, when a key is set) + web_fetch

import registerArbiter from "./arbiter-provider.ts";
import registerClassifier from "./bash-classifier.ts";
import registerAdvisor from "./advisor.ts";
import registerWebTools from "./web-search.ts";
import { readSecrets } from "./secrets.ts";

export default async function (pi: any) {
  const secrets = readSecrets();
  await registerArbiter(pi, secrets);
  registerClassifier(pi, secrets);
  registerAdvisor(pi, secrets);
  registerWebTools(pi, secrets);
}
