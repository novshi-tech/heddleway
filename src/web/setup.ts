import { organizationName, publicUrl } from "../config";
import { listPlugins, PLUGIN_NAME, pluginZip, type Plugin } from "../plugins";
import { masthead } from "./connections";
import { html, type Html } from "./html";
import { page } from "./layout";
import { redirect, session } from "./session";

export const SETUP_PATH = "/setup";

// The name Claude Code knows the connector by: one per deployment, so gateways of
// several organizations can be added side by side (docs/adr/0004).
function serverName(env: Env): string {
  const host = new URL(publicUrl(env)).hostname;
  return `gateway-${host.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`;
}

function copyField(id: string, label: string, value: string): Html {
  return html`<label>${label}<span class="copy"><input type="text" id="${id}" value="${value}" readonly><button type="button" class="quiet" data-copy="${id}" hidden>コピー</button></span></label>`;
}

function pluginRow(plugin: Plugin): Html {
  const needs = plugin.dependencies.length > 0 && `${plugin.dependencies.join("、")} と一緒に使います`;
  return html`<li>
<div class="row-main"><p class="row-title">${plugin.name} <span class="version">${plugin.version}</span></p>${plugin.description && html`<p class="row-sub">${plugin.description}</p>`}${needs && html`<p class="row-sub">${needs}</p>`}</div>
<div class="row-actions">${plugin.source === "uploaded" && html`<span class="badge">管理者が追加</span>`}<a class="button quiet" href="/plugins/${plugin.name}.zip" download>zip をダウンロード</a></div>
</li>`;
}

function claudeCode(plugins: Plugin[]): Html | false {
  const listed = plugins.filter((p) => p.marketplace);
  if (listed.length === 0) return false;
  const markets = [...new Map(listed.map((p) => [p.marketplace!.repo, p.marketplace!])).values()];
  const lines = [
    ...markets.map((m) => `/plugin marketplace add ${m.repo}`),
    ...listed.map((p) => `/plugin install ${p.name}@${p.marketplace!.name}`),
  ];
  return html`<p class="hint">Claude Code では zip を使わず、マーケットプレイスから入れます。使わない提供元のプラグインは省いてかまいません。</p>
<pre><code>${lines.join("\n")}</code></pre>`;
}

export async function setup(request: Request, env: Env): Promise<Response> {
  const user = await session(request, env);
  if (!user) return redirect("/login");
  const organization = organizationName(env);
  const url = `${publicUrl(env)}/mcp`;
  const host = new URL(publicUrl(env)).host;
  const plugins = await listPlugins(env);
  return page(
    "Claude につなぐ",
    html`${masthead(env, user)}
<a class="back" href="/connections">‹ つないだサービスに戻る</a>
<h1>Claude につなぐ</h1>
<p>${organization} のゲートウェイを Claude のコネクタとして追加し、使い方のスキル(プラグイン)を入れます。どちらも 1 回だけで済みます。</p>

<h2>1. コネクタを追加する</h2>
<div class="card">
${copyField("connector-url", "コネクタの URL", url)}
${copyField("connector-name", "コネクタの名前(おすすめ)", `${organization} Gateway`)}
<p class="hint">ほかの組織のゲートウェイも並べてつなぐことがあるので、組織が分かる名前にします。</p>
<ul class="steps">
<li><strong>Pro / Max</strong>: <a href="https://claude.ai/settings/connectors" target="_blank" rel="noopener">設定 &gt; コネクタ</a>で「カスタムコネクタを追加」を選び、名前と URL を入れます。追加したら「連携させる」を押し、このゲートウェイにサインインして許可します。</li>
<li><strong>Team / Enterprise</strong>: 組織の Owner が、組織の設定のコネクタで同じ URL を追加します。メンバーは<a href="https://claude.ai/settings/connectors" target="_blank" rel="noopener">設定 &gt; コネクタ</a>で、そのコネクタの「連携させる」を押します。</li>
<li><strong>Claude Code</strong>: 次のコマンドで追加し、<code>/mcp</code> からサインインします。</li>
</ul>
<pre><code>claude mcp add --transport http ${serverName(env)} ${url}</code></pre>
<p class="hint">Claude のコード実行のネットワーク設定で、接続先のドメインを絞っているときは <code>${host}</code> を許可するドメインに足します(Team / Enterprise では組織の管理者が設定します)。スクリプトがこのドメインの REST を呼ぶためです。</p>
</div>

<h2>2. スキル(プラグイン)を入れる</h2>
<p>Claude アプリ(Cowork など)では、zip をダウンロードして、Customize &gt; Plugins の「Upload plugin」で追加します。まず <code>heddleway</code> を入れ、使うサービスのプラグインを足します。新しい版が出たら、ダウンロードし直して同じようにアップロードします。前の名前のプラグイン(<code>api-gateway</code>、<code>api-gateway-*</code>)を入れていたら、先にアンインストールします。Team / Enterprise では、Owner が組織の設定でまとめて配ることもできます。</p>
${plugins.length > 0
  ? html`<ul class="list">${plugins.map(pluginRow)}</ul>`
  : html`<p class="empty">このゲートウェイで配っているプラグインはありません。管理者に連絡してください。</p>`}
${claudeCode(plugins)}

<h2>3. サービスをつなぐ</h2>
<p>Claude が使うサービス(Google、Microsoft 365、freee など)のアカウントを、<a href="/connections">つないだサービス</a>で登録します。あとは Claude に頼むだけです。</p>
<script src="/assets/app.js" defer></script>`,
  );
}

export async function downloadPlugin(request: Request, env: Env, name: string): Promise<Response> {
  const user = await session(request, env);
  if (!user) return redirect("/login");
  if (!PLUGIN_NAME.test(name)) return new Response("not found", { status: 404 });
  const zip = await pluginZip(env, name);
  if (!zip) return new Response("not found", { status: 404 });
  return new Response(zip.body, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${name}-${zip.version.replace(/[^A-Za-z0-9.+-]/g, "_")}.zip"`,
      "cache-control": "no-store",
    },
  });
}
