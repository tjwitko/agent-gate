// Enough HCL structure to find Kubernetes objects declared through Terraform's kubernetes provider.
//
// k8s-manifest and iam-contract both located Kubernetes objects by walking .yaml/.yml, so a project
// managing its cluster from Terraform — `kubernetes_deployment`, `kubernetes_service_account` and
// friends — was invisible to both. manifest-contract had already solved the same problem with
// TF_KUBERNETES_WORKLOAD; this is that idea factored out so all three agree on what counts.
//
// Brace-matched rather than regex-windowed. HCL nests deeply (resource > spec > template > spec >
// container > liveness_probe) and a fixed window would read one container's settings into another's
// verdict — the same defect already fixed twice in the authentication check.

/** Every `resource "<type>" "<label>" { … }` whose type matches `typeRe`, with its full body. */
export function hclResources(text, typeRe) {
  const out = [];
  const head = /resource\s+"([\w]+)"\s+"([\w-]+)"\s*\{/g;
  let m;
  while ((m = head.exec(text))) {
    if (!typeRe.test(m[1])) continue;
    const body = blockAt(text, m.index + m[0].length - 1);
    if (body !== null) out.push({ type: m[1], label: m[2], body });
  }
  return out;
}

/** Every `<name> { … }` block directly or indirectly inside `text`, with its body. */
export function hclBlocks(text, name) {
  const out = [];
  const head = new RegExp(`\\b${name}\\s*\\{`, "g");
  let m;
  while ((m = head.exec(text))) {
    const body = blockAt(text, m.index + m[0].length - 1);
    if (body !== null) out.push(body);
  }
  return out;
}

/** The body of the brace pair opening at `openIdx`, exclusive of the outer braces. */
export function blockAt(text, openIdx) {
  if (text[openIdx] !== "{") return null;
  let depth = 0;
  let inString = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    // Braces inside a quoted string are not structure. `"${var.x}"` would otherwise unbalance the
    // count, and interpolation is everywhere in the manifests this reads.
    if (c === '"' && text[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  return null;
}

/** `name = "value"` at any depth of `text`. */
export function hclAttr(text, attr) {
  const m = new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`).exec(text);
  return m ? m[1] : null;
}

/** `name = <number>` at any depth of `text`, unquoted or quoted. Returns null when absent. */
export function hclNumber(text, attr) {
  const m = new RegExp(`\\b${attr}\\s*=\\s*"?(-?\\d+(?:\\.\\d+)?)"?`).exec(text);
  return m ? Number(m[1]) : null;
}

/** `name = true|false` at any depth of `text`. Returns null when absent, so "absent" and "false"
 *  stay distinguishable — a setting that defaults to on must not read as off merely by omission. */
export function hclBool(text, attr) {
  const m = new RegExp(`\\b${attr}\\s*=\\s*"?(true|false)"?`, "i").exec(text);
  return m ? m[1].toLowerCase() === "true" : null;
}

/** Every `variable "name" { default = ... }` in `text`, as name -> raw default (quotes stripped).
 *  Numbers as well as strings: a retention period is `default = 2555`, and a string-only reader
 *  silently returns nothing for it, which is indistinguishable from the variable not existing. */
export function hclVariableDefaults(text) {
  // Brace-matched, not `\n}`-terminated. A regex anchored on a closing brace at column zero reads
  // conventionally formatted .tf and silently returns nothing for a block indented inside another
  // -- and "no default" is indistinguishable from "no such variable", so a resolvable retention
  // period read as unresolvable.
  const defaults = new Map();
  const re = /variable\s+"(\w+)"\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const body = blockAt(text, text.indexOf("{", m.index));
    if (body === null) continue;
    const d = /\bdefault\s*=\s*(?:"([^"]*)"|(-?\d+(?:\.\d+)?|true|false))/.exec(body);
    if (d) defaults.set(m[1], d[1] !== undefined ? d[1] : d[2]);
  }
  return defaults;
}

// Long-lived workloads only. A Job or CronJob legitimately has no readiness probe, exactly as in
// the YAML path.
export const TF_SERVER_WORKLOAD = /^kubernetes_(deployment|stateful_set|daemon_set|replication_controller)(_v1)?$/;
export const TF_SERVICE_ACCOUNT = /^kubernetes_service_account(_v1)?$/;
