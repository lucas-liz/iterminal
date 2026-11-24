package com.ruoyi.iterminal.service;

import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.scheduling.support.CronTrigger;
import org.springframework.stereotype.Service;
import com.ruoyi.iterminal.mapper.ItmApprovalMapper;
import com.ruoyi.iterminal.mapper.ItmAuditCommandMapper;
import com.ruoyi.iterminal.mapper.ItmAuditSessionMapper;
import com.ruoyi.iterminal.mapper.ItmLlmUsageMapper;
import com.ruoyi.iterminal.mapper.ItmNotifyLogMapper;
import com.ruoyi.iterminal.mapper.ItmSchedRunMapper;
import com.ruoyi.system.service.ISysConfigService;

/**
 * 保留期限清理（每天 03:30，启动 2 分钟后也执行一次）：
 * 命令审计、执行记录、已处理的审批、团队模型用量保留 itm.audit.retentionDays 天（默认 180）；
 * 会话录像（数据库记录和 .cast 文件）保留 itm.recording.retentionDays 天（默认 30）；通知发送记录保留 itm.notify.retentionDays 天（默认 30）。
 * 分批删除（每批 5000 条），避免长时间锁表。
 */
@Service
public class ItmRetentionService
{
    private static final Logger log = LoggerFactory.getLogger(ItmRetentionService.class);

    public static final String AUDIT_DAYS = "itm.audit.retentionDays";
    public static final String RECORDING_DAYS = "itm.recording.retentionDays";
    private static final int BATCH = 5000;

    @Autowired
    private ISysConfigService configService;

    @Autowired
    private ItmAuditCommandMapper auditMapper;

    @Autowired
    private ItmAuditSessionMapper sessionMapper;

    @Autowired
    private ItmSchedRunMapper runMapper;

    @Autowired
    private ItmApprovalMapper approvalMapper;

    @Autowired
    private ItmAuditService auditService;

    @Autowired
    private ItmNotifyLogMapper notifyLogMapper;

    @Autowired
    private ItmLlmUsageMapper llmUsageMapper;

    @Autowired
    private ItmCloudService cloudService;

    @Autowired
    private ItmFeedbackService feedbackService;

    @Autowired
    @Qualifier("itmScheduler")
    private ThreadPoolTaskScheduler scheduler;

    @EventListener(ApplicationReadyEvent.class)
    public void start()
    {
        scheduler.schedule(this::runSafely, new CronTrigger("0 30 3 * * ?"));
        scheduler.schedule(this::runSafely, Instant.now().plus(Duration.ofMinutes(2)));
    }

    private void runSafely()
    {
        try
        {
            Map<String, Integer> r = cleanup();
            if (r.values().stream().anyMatch(n -> n > 0))
            {
                log.info("iTerminal 保留期限清理：{}", r);
            }
        }
        catch (Exception e)
        {
            log.warn("iTerminal 保留期限清理失败：{}", e.getMessage());
        }
    }

    /** 执行一次清理，返回各类删除的条数 */
    public Map<String, Integer> cleanup()
    {
        int auditDays = days(AUDIT_DAYS, 180);
        int recordingDays = days(RECORDING_DAYS, 30);
        Date auditBefore = Date.from(Instant.now().minus(Duration.ofDays(auditDays)));
        Date recordingBefore = Date.from(Instant.now().minus(Duration.ofDays(recordingDays)));
        Map<String, Integer> out = new LinkedHashMap<>();
        out.put("audit", repeat(() -> auditMapper.deleteBefore(auditBefore, BATCH)));
        out.put("runs", repeat(() -> runMapper.deleteBefore(auditBefore, BATCH)));
        out.put("approvals", repeat(() -> approvalMapper.deleteBefore(auditBefore, BATCH)));
        out.put("llmUsage", repeat(() -> llmUsageMapper.deleteBefore(auditBefore, BATCH)));
        int recordings = 0;
        for (;;)
        {
            List<String> ids = sessionMapper.selectIdsBefore(recordingBefore, 500);
            if (ids.isEmpty())
            {
                break;
            }
            recordings += auditService.deleteSessions(ids.toArray(new String[0]));
            if (ids.size() < 500)
            {
                break;
            }
        }
        out.put("recordings", recordings);
        Date notifyBefore = Date.from(Instant.now().minus(Duration.ofDays(days("itm.notify.retentionDays", 30))));
        out.put("notifyLogs", repeat(() -> notifyLogMapper.deleteBefore(notifyBefore, BATCH)));
        // 已删除用户的云备份和分享码
        out.put("orphanBackups", cloudService.cleanupDeletedUsers());
        // 单项分享：撤销 / 过期 / 拉满 7 天后删分享包（第十三轮）
        out.put("shareLinks", cloudService.cleanupLinks());
        out.put("feedback", feedbackService.cleanup(days("itm.feedback.retentionDays", 365)));
        return out;
    }

    private interface Batch
    {
        int run();
    }

    private static int repeat(Batch b)
    {
        int total = 0;
        for (int i = 0; i < 1000; i++)
        {
            int n = b.run();
            total += n;
            if (n < BATCH)
            {
                break;
            }
        }
        return total;
    }

    /** 参数设置里的天数；不合法时用默认值，最少 1 天 */
    private int days(String key, int fallback)
    {
        try
        {
            int v = Integer.parseInt(configService.selectConfigByKey(key).trim());
            return Math.max(1, Math.min(v, 3650));
        }
        catch (Exception e)
        {
            return fallback;
        }
    }
}
