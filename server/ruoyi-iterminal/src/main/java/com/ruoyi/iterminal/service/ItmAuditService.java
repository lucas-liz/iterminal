package com.ruoyi.iterminal.service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.text.SimpleDateFormat;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ruoyi.common.config.RuoYiConfig;
import com.ruoyi.common.utils.StringUtils;
import com.ruoyi.iterminal.api.ApiException;
import com.ruoyi.iterminal.domain.ItmAuditCommand;
import com.ruoyi.iterminal.domain.ItmAuditSession;
import com.ruoyi.iterminal.domain.ItmDevice;
import com.ruoyi.iterminal.mapper.ItmAuditCommandMapper;
import com.ruoyi.iterminal.mapper.ItmAuditSessionMapper;

/**
 * 审计上报（文档二 5.11）：命令和安全事件批量写入（同一设备的事件ID去重）；会话录像按分片追加到文件
 * （{上传目录}/itm/recordings/yyyyMM/{录像ID}.cast），客户端重发的分片忽略。
 */
@Service
public class ItmAuditService
{
    private static final int MAX_BATCH = 500;
    private static final Pattern RECORDING_ID = Pattern.compile("^[A-Za-z0-9_-]{1,64}$");
    /** 单个录像最多 200MB（客户端本身限制 100MB） */
    private static final long MAX_RECORDING = 200L * 1024 * 1024;

    @Autowired
    private ItmNotifyService notifyService;

    @Autowired
    private ItmAuditCommandMapper commandMapper;

    @Autowired
    private ItmAuditSessionMapper sessionMapper;

    @Autowired
    private ObjectMapper objectMapper;

    @SuppressWarnings("unchecked")
    public int uploadCommands(ItmDevice device, Object rawItems)
    {
        if (!(rawItems instanceof List<?> items))
        {
            throw ApiException.badRequest("items 需要是数组");
        }
        if (items.size() > MAX_BATCH)
        {
            throw ApiException.badRequest("一次最多上报 " + MAX_BATCH + " 条");
        }
        List<ItmAuditCommand> rows = new ArrayList<>();
        for (Object o : items)
        {
            if (!(o instanceof Map<?, ?> m))
            {
                continue;
            }
            Map<String, Object> i = (Map<String, Object>) m;
            String eventId = ItmApprovalService.str(i.get("clientEventId"), 64);
            if (StringUtils.isEmpty(eventId))
            {
                continue;
            }
            ItmAuditCommand c = new ItmAuditCommand();
            c.setClientEventId(eventId);
            c.setDeviceId(device.getDeviceId());
            c.setUserId(device.getUserId());
            c.setUserName(device.getUserName());
            c.setKind("EVENT".equals(i.get("kind")) ? "EVENT" : "COMMAND");
            c.setSource(ItmApprovalService.str(i.get("source"), 20));
            c.setEventType(ItmApprovalService.str(i.get("eventType"), 64));
            c.setHostId(ItmApprovalService.str(i.get("hostId"), 64));
            c.setHostName(ItmApprovalService.str(i.get("hostName"), 200));
            c.setSessionId(ItmApprovalService.str(i.get("sessionId"), 64));
            c.setCommand(ItmApprovalService.str(i.get("command"), 60_000));
            c.setRisk(ItmApprovalService.str(i.get("risk"), 10));
            c.setDecision(ItmApprovalService.str(i.get("decision"), 16));
            c.setExitCode(i.get("exitCode") instanceof Number n ? n.intValue() : null);
            try
            {
                String detail = i.get("detail") == null ? null : objectMapper.writeValueAsString(i.get("detail"));
                c.setDetail(detail != null && detail.length() > 60_000 ? detail.substring(0, 60_000) : detail);
            }
            catch (Exception e)
            {
                c.setDetail(null);
            }
            c.setOccurredAt(parseTime(i.get("occurredAt")));
            rows.add(c);
        }
        if (!rows.isEmpty())
        {
            // 高危 / 禁止的命令：只对第一次上报的发通知（客户端重发的批次不重复通知）
            List<ItmAuditCommand> risky = rows.stream().filter(c -> "COMMAND".equals(c.getKind()) && ("L2".equals(c.getRisk()) || "DENY".equals(c.getRisk()))).toList();
            List<String> seen = risky.isEmpty() ? List.of() : commandMapper.selectExistingEventIds(device.getDeviceId(), risky.stream().map(ItmAuditCommand::getClientEventId).toList());
            commandMapper.insertIgnoreBatch(rows);
            List<ItmAuditCommand> fresh = risky.stream().filter(c -> !seen.contains(c.getClientEventId())).toList();
            if (!fresh.isEmpty())
            {
                notifyHighRisk(device, fresh);
            }
        }
        return rows.size();
    }

    private static final Map<String, String> SOURCE_LABEL = Map.of("USER", "手动", "AGENT", "Agent", "SKILL", "Skill", "SCHEDULE", "定时任务", "MCP_EXTERNAL", "外部 MCP");
    private static final Map<String, String> DECISION_LABEL = Map.of("AUTO", "自动执行", "APPROVED", "已批准", "REJECTED", "已拒绝", "DENIED", "已禁止");

    private void notifyHighRisk(ItmDevice device, List<ItmAuditCommand> list)
    {
        Map<String, String> f = new java.util.LinkedHashMap<>();
        f.put("用户", device.getUserName());
        f.put("设备", StringUtils.nvl(device.getDeviceName(), device.getDeviceId()));
        int i = 0;
        for (ItmAuditCommand c : list)
        {
            if (++i > 10)
            {
                f.put("……", "还有 " + (list.size() - 10) + " 条，请在管理后台查看");
                break;
            }
            String label = ("DENY".equals(c.getRisk()) ? "禁止" : "高危") + " #" + i;
            f.put(label, StringUtils.nvl(c.getHostName(), "本机") + "：" + StringUtils.substring(StringUtils.nvl(c.getCommand(), ""), 0, 300)
                + "（" + SOURCE_LABEL.getOrDefault(StringUtils.nvl(c.getSource(), ""), StringUtils.nvl(c.getSource(), "")) + "，" + DECISION_LABEL.getOrDefault(StringUtils.nvl(c.getDecision(), ""), StringUtils.nvl(c.getDecision(), "—")) + "）");
        }
        notifyService.publish(ItmNotifyService.AUDIT_HIGH_RISK, "命令审计出现 " + list.size() + " 条高危命令", f, "/iterminal/audit");
    }

    /** 录像分片：index 从 0 开始，final 表示最后一片；第一片带元数据 */
    @SuppressWarnings("unchecked")
    public void uploadChunk(ItmDevice device, String recordingId, Map<String, Object> body)
    {
        if (recordingId == null || !RECORDING_ID.matcher(recordingId).matches())
        {
            throw ApiException.badRequest("录像ID不正确");
        }
        int index = body.get("index") instanceof Number n ? n.intValue() : -1;
        String content = body.get("content") == null ? "" : String.valueOf(body.get("content"));
        boolean last = Boolean.TRUE.equals(body.get("final"));
        if (index < 0)
        {
            throw ApiException.badRequest("缺少分片序号");
        }
        ItmAuditSession s = sessionMapper.selectItmAuditSessionById(recordingId);
        if (s != null && !device.getDeviceId().equals(s.getDeviceId()))
        {
            throw ApiException.forbidden("录像属于其他设备");
        }
        if (index == 0 && s == null)
        {
            Map<String, Object> meta = body.get("meta") instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
            s = new ItmAuditSession();
            s.setRecordingId(recordingId);
            s.setDeviceId(device.getDeviceId());
            s.setUserId(device.getUserId());
            s.setUserName(device.getUserName());
            s.setSessionId(ItmApprovalService.str(meta.get("sessionId"), 64));
            s.setKind(ItmApprovalService.str(meta.get("kind"), 16));
            s.setHostId(ItmApprovalService.str(meta.get("hostId"), 64));
            s.setHostName(ItmApprovalService.str(meta.get("hostName"), 200));
            s.setCols(meta.get("cols") instanceof Number c ? c.intValue() : 80);
            s.setRowsCount(meta.get("rows") instanceof Number r ? r.intValue() : 24);
            s.setStartedAt(parseTime(meta.get("startedAt")));
            s.setEndedAt(meta.get("endedAt") == null ? null : parseTime(meta.get("endedAt")));
            s.setChunks(0);
            s.setBytes(0L);
            s.setComplete("0");
            s.setFilePath("itm/recordings/" + new SimpleDateFormat("yyyyMM").format(new Date()) + "/" + recordingId + ".cast");
            sessionMapper.insertItmAuditSession(s);
        }
        if (s == null)
        {
            throw ApiException.conflict("缺少第一个分片，请从头重新上传");
        }
        if (index < s.getChunks() || "1".equals(s.getComplete()))
        {
            // 客户端重发（上次没收到响应）：已经写过了
            return;
        }
        if (index > s.getChunks())
        {
            throw ApiException.conflict("分片不连续：已收到 " + s.getChunks() + " 片");
        }
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        if (s.getBytes() + bytes.length > MAX_RECORDING)
        {
            throw ApiException.badRequest("录像太大");
        }
        Path file = Path.of(RuoYiConfig.getProfile(), s.getFilePath());
        try
        {
            Files.createDirectories(file.getParent());
            if (index == 0)
            {
                Files.write(file, bytes, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
            }
            else
            {
                Files.write(file, bytes, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            }
        }
        catch (IOException e)
        {
            throw new ApiException(org.springframework.http.HttpStatus.INTERNAL_SERVER_ERROR, "保存录像失败");
        }
        ItmAuditSession upd = new ItmAuditSession();
        upd.setRecordingId(recordingId);
        upd.setChunks(index + 1);
        upd.setBytes(s.getBytes() + bytes.length);
        upd.setComplete(last ? "1" : "0");
        sessionMapper.updateItmAuditSession(upd);
    }

    /** 读取录像内容（asciicast v2 文本），管理后台回放用 */
    public String readCast(String recordingId)
    {
        ItmAuditSession s = sessionMapper.selectItmAuditSessionById(recordingId);
        if (s == null)
        {
            return null;
        }
        try
        {
            return Files.readString(Path.of(RuoYiConfig.getProfile(), s.getFilePath()), StandardCharsets.UTF_8);
        }
        catch (IOException e)
        {
            return null;
        }
    }

    public int deleteSessions(String[] ids)
    {
        for (String id : ids)
        {
            ItmAuditSession s = sessionMapper.selectItmAuditSessionById(id);
            if (s != null)
            {
                try
                {
                    Files.deleteIfExists(Path.of(RuoYiConfig.getProfile(), s.getFilePath()));
                }
                catch (IOException ignored)
                {
                    // 文件已经不在了
                }
            }
        }
        return sessionMapper.deleteItmAuditSessionByIds(ids);
    }

    private static Date parseTime(Object v)
    {
        if (v instanceof Number n)
        {
            return new Date(n.longValue());
        }
        if (v instanceof String s && !s.isEmpty())
        {
            try
            {
                return Date.from(Instant.parse(s));
            }
            catch (Exception ignored)
            {
                // 格式不对时用上报时间
            }
        }
        return new Date();
    }
}
