package com.ruoyi.iterminal.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.apache.poi.hssf.usermodel.HSSFWorkbook;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.junit.jupiter.api.Test;

/** 知识库文档解析：Word 97-2003（.doc）、Excel（.xls / .xlsx）、CSV（第三十三轮） */
class ItmKbExtractTest
{
    private static byte[] workbook(Workbook wb) throws Exception
    {
        Sheet s = wb.createSheet("服务器");
        String[][] rows = { { "主机", "IP", "用途" }, { "web01", "10.0.0.1", "网关" }, { "db01", "10.0.0.2", "" } };
        for (int i = 0; i < rows.length; i++)
        {
            Row r = s.createRow(i);
            for (int j = 0; j < rows[i].length; j++)
            {
                if (!rows[i][j].isEmpty())
                {
                    r.createCell(j).setCellValue(rows[i][j]);
                }
            }
        }
        // 公式取计算结果；空行跳过
        s.createRow(4).createCell(0).setCellValue("合计");
        s.getRow(4).createCell(1).setCellFormula("1+2");
        wb.createSheet("空表");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        wb.write(out);
        wb.close();
        return out.toByteArray();
    }

    @Test
    void xlsxRowsBecomeHeaderValuePairs() throws Exception
    {
        String text = ItmKbService.extract("xlsx", workbook(new XSSFWorkbook()));
        assertTrue(text.startsWith("# 服务器\n\n"), text);
        assertTrue(text.contains("主机: web01；IP: 10.0.0.1；用途: 网关"), text);
        assertTrue(text.contains("主机: db01；IP: 10.0.0.2\n"), text);
        assertTrue(text.contains("主机: 合计；IP: 3"), text);
        assertTrue(!text.contains("空表"), text);
        List<String[]> chunks = ItmKbService.chunk(text);
        assertEquals("服务器", chunks.get(0)[0]);
    }

    @Test
    void xlsUsesTheSameLayout() throws Exception
    {
        String text = ItmKbService.extract("xls", workbook(new HSSFWorkbook()));
        assertTrue(text.contains("主机: web01；IP: 10.0.0.1；用途: 网关"), text);
    }

    @Test
    void csvWithQuotesAndNewlines() throws Exception
    {
        String csv = "名称,命令,说明\n重启,\"systemctl restart nginx\",\"先 nginx -t，\"\"确认\"\"配置\"\n备份,\"tar czf a.tgz /etc\",\"多行\n说明\"\n";
        String text = ItmKbService.extract("csv", csv.getBytes(StandardCharsets.UTF_8));
        assertTrue(text.contains("名称: 重启；命令: systemctl restart nginx；说明: 先 nginx -t，\"确认\"配置"), text);
        assertTrue(text.contains("名称: 备份；命令: tar czf a.tgz /etc；说明: 多行\n说明"), text);
        assertTrue(ItmKbService.extract("tsv", "a\tb\n1\t2".getBytes(StandardCharsets.UTF_8)).contains("a: 1；b: 2"));
    }

    @Test
    void legacyWordDoc() throws Exception
    {
        byte[] data;
        try (InputStream in = getClass().getResourceAsStream("/kb/sample.doc"))
        {
            data = in.readAllBytes();
        }
        String text = ItmKbService.extract("doc", data);
        assertTrue(text.contains("部署手册"), text);
        assertTrue(text.contains("执行 deploy.sh 前先备份数据库。"), text);
        assertTrue(text.contains("回滚命令：rollback.sh v1.2"), text);
    }

    @Test
    void plainTextTypesAreDecoded() throws Exception
    {
        assertEquals("server:\n  port: 8080\n", ItmKbService.extract("yaml", "server:\n  port: 8080\n".getBytes(StandardCharsets.UTF_8)));
    }
}
