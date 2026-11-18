// Text imports (`with { type: 'text' }`), such as the embedded SKILL.md
declare module '*.md' {
  const content: string
  export default content
}
