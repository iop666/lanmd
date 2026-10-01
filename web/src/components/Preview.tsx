import { memo, useMemo } from 'react';
import DOMPurify from 'dompurify';
import md from '../md';

function PreviewInner({ source }: { source: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(md.render(source), { ADD_ATTR: ['target'] }),
    [source],
  );
  return <div className="preview" dangerouslySetInnerHTML={{ __html: html }} />;
}

export default memo(PreviewInner);
