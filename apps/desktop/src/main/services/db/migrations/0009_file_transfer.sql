-- 主机的文件传输方式（第二轮优化）：{"mode":"AUTO|SFTP|FTP|FTPS","ftpPort":21}；NULL 表示自动（先 SFTP，不可用时改用 FTP）
ALTER TABLE host ADD COLUMN file_transfer TEXT;
