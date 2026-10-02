import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

/**
 * Syncfusion's themes `@import` the Inter font from Google Fonts. The app
 * bundles Inter (@fontsource-variable/inter) and its pages connect only to
 * the app itself (the content security policy, the Privacy Policy), so any
 * `@import` of a remote stylesheet is dropped from the CSS it ships.
 */
const dropRemoteImports = {
  postcssPlugin: 'hatax-drop-remote-imports',
  AtRule: {
    import(rule) {
      if (/^(url\(\s*)?["']?(https?:)?\/\//i.test(rule.params)) rule.remove();
    },
  },
};

export default {
  plugins: [dropRemoteImports, tailwindcss(), autoprefixer()],
};
