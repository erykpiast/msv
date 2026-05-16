import ReactMarkdown from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { Typography } from '@mantine/core';

// Default schema permits mailto:/irc:/ircs:/xmpp: hrefs — the synthesis report
// never needs anything beyond http(s):, and the body is pure LLM output.
const schema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https'],
  },
};

export function Markdown({ children }: { children: string }) {
  return (
    <Typography>
      <ReactMarkdown rehypePlugins={[[rehypeSanitize, schema]]}>{children}</ReactMarkdown>
    </Typography>
  );
}
