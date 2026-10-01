import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/** markdown 源码 → 纯文本（渲染后剥离标签，保留代码块换行） */
export function markdownToPlainText(source: string): string {
  const div = document.createElement('div');
  div.innerHTML = md.render(source);
  return (div.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

export default md;
