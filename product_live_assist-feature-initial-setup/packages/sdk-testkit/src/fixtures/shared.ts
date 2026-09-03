export const FIXTURE_STYLE = `
  :root { color-scheme: light; font-family: system-ui, sans-serif; }
  body { margin: 24px; color: #172033; background: #fff; }
  nav, main, form, section { display: grid; gap: 12px; max-width: 760px; }
  button, input, select, a { font: inherit; padding: 8px 12px; }
  [role="alert"] { padding: 10px; border: 1px solid #248a3d; }
  [hidden] { display: none !important; }
`;

export function htmlDocument(options: {
  title: string;
  body: string;
  head?: string;
  script?: string;
  lang?: string;
}): string {
  const lang = options.lang ?? "en";
  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${options.title}</title>
  <style>${FIXTURE_STYLE}</style>
  ${options.head ?? ""}
</head>
<body>
${options.body}
${options.script ? `<script>${options.script}</script>` : ""}
</body>
</html>`;
}
