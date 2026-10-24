/**
 * 从模型原始输出里分离“简要介绍”文字（如果有）。
 *
 * prompt.md 要求只输出代码，正常情况下这里会返回 undefined；
 * 此函数为“模型未来若附上简短说明”预留：把代码/像素行剔除后，
 * 剩余的普通文字作为介绍，供前端以普通对话气泡展示。
 */
export function extractIntro(raw: string): string | undefined {
  let text = raw;
  // 去掉 fenced code block（包含其中的代码）
  text = text.replace(/```[\s\S]*?```/g, "\n");
  // 去掉 `const x = img`...`;`（连变量声明和结尾分号）
  text = text.replace(
    /(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*img`[\s\S]*?`\s*;?/g,
    "\n",
  );
  // 去掉裸露的 img`...`
  text = text.replace(/img`[\s\S]*?`\s*;?/g, "\n");
  // 去掉 CombinedTiles 调用（多行）
  text = text.replace(/(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*new\s+CombinedTiles\([\s\S]*?\)\s*;?/g, "\n");
  text = text.replace(/new\s+CombinedTiles\([\s\S]*?\)\s*;?/g, "\n");

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (/^(const|let|var|export|import|function|return|type|interface)\b/.test(l)) return false;
      if (/^new\s+CombinedTiles\b/.test(l)) return false;
      // 代码残留的孤立符号（如 `;`、`);`）
      if (/^[;)\]}]+$/.test(l)) return false;
      // 像素行：每个 token 都是单个 `.`/hex 字符（避免把英文单词如 "face" 误判成像素行）
      const tokens = l.split(/\s+/);
      if (tokens.length > 1 && tokens.every((t) => /^[.1-9a-fA-F]$/.test(t))) return false;
      if (l === ".") return false;
      return true;
    });

  const intro = lines.join("\n").trim();
  if (!intro) return undefined;
  return intro.length > 800 ? `${intro.slice(0, 800)}…` : intro;
}
