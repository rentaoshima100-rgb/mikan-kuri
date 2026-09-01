// 一次情報 (primary_info_assets) を投入する。
//   npx tsx scripts/seed/seed_assets.ts [--file <path>] [--plan] [--replace]
// 既定の入力は .local/primary_assets.json (gitignore済み。実名・案件情報を含んでよい)。
//
// なぜ .local か:
//   一次情報の content は改修/生成記事に注入され、最終的に公開される。よって
//   content 自体は匿名化済み (クライアント実名や特定情報を含まない) で書くこと。
//   一方このファイルはリポジトリにコミットしない (.gitignore) ので、numeric_claims の
//   basis (測定した圃場の区画名など) に踏み込んだメモを残しても、リポジトリには出ない。
//
//   content に書いてはいけないもの: 効能効果 (免疫力アップ等)、根拠のない最上級 (日本一等)、
//   無農薬・減農薬・オーガニックの表記、お客さまの個人情報。
//   これらは公開時に法令ゲートで止まるが、素材の時点で入れないこと。
//
// 投入先スキーマ: supabase/migrations/0002_content.sql の primary_info_assets
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const ASSET_TYPES = [
  "field_record", // 畑の記録 (作業、樹の状態、収穫の様子)
  "measurement", // 実測値 (糖度、重量、サイズ、収量)
  "weather", // その年の天候と生育への影響
  "customer_voice", // お客さまの声 (個人が特定できない形に整えたもの)
  "public_data", // 公的統計の分析 (作付面積、出荷量)
  "process", // 選別・貯蔵・出荷の手順
] as const;
const CLUSTERS = ["citrus_variety", "growing", "eating", "gift", "chestnut"] as const;
const SENSITIVITY = ["low", "mid", "high"] as const;

interface NumericClaim {
  claim: string; // 何の数値か
  value: string; // 数値 (文字列でよい: "45%", "50〜100万円")
  unit?: string; // 単位 (任意)
  basis: string; // 根拠・帰属 ("当社実測 n=12" / "総務省 通信利用動向調査 2025" 等)
  verified: boolean; // 裏が取れているものだけ true。false は投入しない
}

interface AssetInput {
  asset_type: (typeof ASSET_TYPES)[number];
  title: string;
  description: string; // どんな一次情報か (P-13a/P-01が選択に使う要約)
  content: string; // 記事本文へ注入される文章。★公開前提なので匿名化済みで書く★
  numeric_claims?: NumericClaim[];
  applicable_clusters: (typeof CLUSTERS)[number][];
  sensitivity?: (typeof SENSITIVITY)[number];
  source_permission?: boolean; // 二次利用/掲載の許諾が取れているか
  valid_until?: string; // "YYYY-MM-DD" 鮮度が切れる日 (任意)
}

function validate(a: AssetInput, i: number): string[] {
  const errs: string[] = [];
  const at = (m: string) => `assets[${i}] (${a.title ?? "無題"}): ${m}`;
  if (!ASSET_TYPES.includes(a.asset_type)) errs.push(at(`asset_type不正: ${a.asset_type}`));
  if (!a.title?.trim()) errs.push(at("titleが空"));
  if (!a.description?.trim()) errs.push(at("descriptionが空"));
  if (!a.content?.trim()) errs.push(at("contentが空"));
  if (!Array.isArray(a.applicable_clusters) || a.applicable_clusters.length === 0)
    errs.push(at("applicable_clustersが空"));
  for (const c of a.applicable_clusters ?? [])
    if (!CLUSTERS.includes(c)) errs.push(at(`applicable_clusters不正: ${c}`));
  if (a.sensitivity && !SENSITIVITY.includes(a.sensitivity))
    errs.push(at(`sensitivity不正: ${a.sensitivity}`));
  for (const [j, n] of (a.numeric_claims ?? []).entries()) {
    if (!n.verified) errs.push(at(`numeric_claims[${j}] verified=falseは投入不可 (裏が取れた数値のみ)`));
    if (!n.basis?.trim()) errs.push(at(`numeric_claims[${j}] basis(根拠)が空`));
  }
  return errs;
}

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const file = argOf("--file") ?? join(process.cwd(), ".local", "primary_assets.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    console.error(`入力ファイルが読めません: ${file}`);
    console.error("scripts/seed/primary_assets.example.json をコピーして .local/primary_assets.json を作り、実データを記入してください。");
    process.exit(1);
  }
  const assets = JSON.parse(raw) as AssetInput[];
  if (!Array.isArray(assets)) throw new Error("トップレベルはassetの配列である必要があります");

  const errs = assets.flatMap((a, i) => validate(a, i));
  if (errs.length) {
    console.error(`検証エラー ${errs.length}件:`);
    for (const e of errs) console.error("  - " + e);
    process.exit(1);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || process.argv.includes("--plan")) {
    console.log(`[plan] 投入予定の一次情報: ${assets.length}件`);
    for (const a of assets)
      console.log(
        `  [${a.asset_type}] ${a.title} → clusters=${a.applicable_clusters.join(",")} / numeric_claims=${(a.numeric_claims ?? []).length}件`,
      );
    console.log("実投入にはSUPABASE_URL/SUPABASE_SERVICE_ROLE_KEYが必要です (--planを外す)");
    return;
  }

  const replace = process.argv.includes("--replace");
  const supabase = createClient(url, key);
  let inserted = 0;
  let skipped = 0;
  for (const a of assets) {
    const { data: existing, error: selErr } = await supabase
      .from("primary_info_assets")
      .select("id")
      .eq("title", a.title)
      .maybeSingle();
    if (selErr) throw new Error(`select失敗 (${a.title}): ${selErr.message}`);

    const row = {
      asset_type: a.asset_type,
      title: a.title,
      description: a.description,
      content: a.content,
      numeric_claims: a.numeric_claims ?? [],
      applicable_clusters: a.applicable_clusters,
      sensitivity: a.sensitivity ?? "low",
      source_permission: a.source_permission ?? true,
      valid_until: a.valid_until ?? null,
      status: "active",
    };

    if (existing) {
      if (!replace) {
        skipped++;
        console.log(`  skip (既存): ${a.title}  ※上書きするなら --replace`);
        continue;
      }
      const { error } = await supabase
        .from("primary_info_assets")
        .update(row)
        .eq("id", existing.id);
      if (error) throw new Error(`update失敗 (${a.title}): ${error.message}`);
      console.log(`  update: ${a.title}`);
      inserted++;
    } else {
      const { error } = await supabase.from("primary_info_assets").insert(row);
      if (error) throw new Error(`insert失敗 (${a.title}): ${error.message}`);
      console.log(`  insert: ${a.title}`);
      inserted++;
    }
  }
  console.log(`一次情報を投入しました: ${inserted}件 (スキップ ${skipped}件)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
