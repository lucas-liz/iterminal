/** electron-vite：import x from './file?asset' 得到打包后文件的绝对路径 */
declare module '*?asset' {
  const path: string;
  export default path;
}
