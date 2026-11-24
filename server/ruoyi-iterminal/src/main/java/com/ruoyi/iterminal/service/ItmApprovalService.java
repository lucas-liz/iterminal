package com.ruoyi.iterminal.service;

import java.time.Duration;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.stereotype.Service;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ruoyi.common.core.domain.entity.SysUser;
import com.ruoyi.common.utils.StringUtils;
import com.ruoyi.framework.web.service.SysPermissionService;
import com.ruoyi.iterminal.api.ApiException;
import com.ruoyi.iterminal.domain.ItmApproval;
import com.ruoyi.iterminal.domain.ItmSchedRun;
import com.ruoyi.iterminal.mapper.ItmApprovalMapper;
import com.ruoyi.iterminal.mapper.ItmSchedRunMapper;
import com.ruoyi.iterminal.ws.ClientWsHandler;
import com.ruoyi.iterminal.ws.WsMessageListener;
import com.ruoyi.system.service.ISysConfigService;
import com.ruoyi.system.service.ISysUserService;

/**
 * 远程审批（文档二 7.2）：
 * 执行器（定时任务派发到的设备）遇到超出权限上限的写操作时创建审批 → 推送 approval.request 给所有审批人的在线设备
 * （审批人的设备上线时补发还没处理的）→ 审批人在客户端（approval.decide）或管理后台处理 → approval.result 发给执行器
 * 和其他审批人的设备（从待审批里移除）。过期的自动标记 EXPIRED 并通知执行器。
 */
@Service
public class ItmApprovalService implements WsMessageListener
{
    private static final Logger log = LoggerFactory.getLogger(ItmApprovalService.class);
    public static final String PERM = "itm:approval:decide";

    @Autowired
    private ItmNotifyService notifyService;

    @Autowired
    private ItmApprovalMapper approvalMapper;

    @Autowired
    private ItmSchedRunMapper runMapper;

    @Autowired
    private ClientWsHandler ws;

    @Autowired
    private ISysConfigService configService;

    @Autowired
    private ISysUserService userService;

    @Autowired
    private SysPermissionService permissionService;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    @Qualifier("itmScheduler")
    private ThreadPoolTaskScheduler scheduler;

    @PostConstruct
    public void init()
    {
        scheduler.scheduleWithFixedDelay(this::expireDue, Duration.ofSeconds(30));
    }

    /** 执行器创建审批 */
    public Map<String, Object> create(String deviceId, String runId, Map<String, Object> body)
    {
        ItmSchedRun run = runMapper.selectItmSchedRunById(runId);
        if (run == null)
        {
            throw ApiException.notFound("执行记录不存在");
        }
        if (!deviceId.equals(run.getDeviceId()))
        {
            throw ApiException.forbidden("只有执行这个任务的设备才能发起审批");
        }
        String command = str(body.get("command"), 10_000);
        if (StringUtils.isEmpty(command))
        {
            throw ApiException.badRequest("缺少命令");
        }
        ItmApproval a = new ItmApproval();
        a.setApprovalId("ap-" + UUID.randomUUID());
        a.setRunId(runId);
        a.setTaskId(run.getTaskId());
        a.setTaskName(run.getTaskName());
        a.setDeviceId(deviceId);
        a.setHostId(str(body.get("hostId"), 200));
        a.setHostName(StringUtils.isNotEmpty(str(body.get("hostName"), 200)) ? str(body.get("hostName"), 200) : a.getHostId());
        a.setCommand(command);
        String risk = str(body.get("risk"), 10);
        a.setRisk(StringUtils.isEmpty(risk) ? "L1" : risk);
        try
        {
            a.setReasons(body.get("reasons") == null ? "[]" : objectMapper.writeValueAsString(body.get("reasons")));
        }
        catch (Exception e)
        {
            a.setReasons("[]");
        }
        a.setExplanation(str(body.get("explanation"), 1000));
        a.setExpiresAt(new Date(System.currentTimeMillis() + expireMinutes() * 60_000L));
        approvalMapper.insertItmApproval(a);
        ws.sendToUsers(approverIds(), "approval.request", requestPayload(a), true);
        notifyApproval(ItmNotifyService.APPROVAL_REQUEST, "有命令等待审批：" + StringUtils.nvl(a.getTaskName(), ""), a);
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("approvalId", a.getApprovalId());
        r.put("expiresAt", a.getExpiresAt().toInstant().toString());
        return r;
    }

    /** 待我审批（客户端「审批」页） */
    public List<ItmApproval> pending()
    {
        ItmApproval q = new ItmApproval();
        q.setStatus("PENDING");
        return approvalMapper.selectItmApprovalList(q);
    }

    /**
     * 处理审批。operator 为审批人账号；permissions 为审批人的权限（管理员是 *:*:*）。
     */
    public void decide(String approvalId, String decision, String comment, String operator, Set<String> permissions)
    {
        if (permissions == null || !(permissions.contains("*:*:*") || permissions.contains(PERM)))
        {
            throw ApiException.forbidden("没有审批权限");
        }
        if (!"APPROVED".equals(decision) && !"REJECTED".equals(decision))
        {
            throw ApiException.badRequest("decision 只能是 APPROVED 或 REJECTED");
        }
        ItmApproval a = approvalMapper.selectItmApprovalById(approvalId);
        if (a == null)
        {
            throw ApiException.notFound("审批不存在");
        }
        if (approvalMapper.decide(approvalId, decision, operator, StringUtils.substring(StringUtils.nvl(comment, ""), 0, 500)) == 0)
        {
            throw ApiException.conflict("这个审批已经被处理或已过期");
        }
        notifyResult(a, decision, operator);
    }

    private void expireDue()
    {
        try
        {
            for (ItmApproval a : approvalMapper.selectDue(new Date()))
            {
                if (approvalMapper.decide(a.getApprovalId(), "EXPIRED", "system", "超时没有处理") > 0)
                {
                    notifyResult(a, "EXPIRED", "system");
                    notifyApproval(ItmNotifyService.APPROVAL_EXPIRED, "审批已过期（没人处理，命令没有执行）：" + StringUtils.nvl(a.getTaskName(), ""), a);
                }
            }
        }
        catch (Exception e)
        {
            log.warn("处理过期审批失败：{}", e.getMessage());
        }
    }

    private static final Map<String, String> RISK_LABEL = Map.of("L0", "只读", "L1", "写操作", "L2", "高危", "DENY", "禁止");

    private void notifyApproval(String event, String title, ItmApproval a)
    {
        Map<String, String> f = new LinkedHashMap<>();
        f.put("任务", a.getTaskName());
        f.put("主机", a.getHostName());
        f.put("命令", StringUtils.substring(a.getCommand(), 0, 500));
        f.put("风险", RISK_LABEL.getOrDefault(a.getRisk(), a.getRisk()));
        if (StringUtils.isNotEmpty(a.getExplanation()))
        {
            f.put("Agent 说明", a.getExplanation());
        }
        f.put("执行设备", notifyService.deviceLabel(a.getDeviceId()));
        if (ItmNotifyService.APPROVAL_REQUEST.equals(event) && a.getExpiresAt() != null)
        {
            f.put("过期时间", new java.text.SimpleDateFormat("MM-dd HH:mm").format(a.getExpiresAt()));
        }
        notifyService.publish(event, title, f, "/iterminal/approval");
    }

    private void notifyResult(ItmApproval a, String decision, String by)
    {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("approvalId", a.getApprovalId());
        p.put("runId", a.getRunId());
        p.put("decision", decision);
        p.put("by", by);
        // 执行器据此继续或跳过这台主机；其他审批人的设备据此移除这条待审批
        ws.send(a.getDeviceId(), "approval.result", p, true);
        ws.sendToUsers(approverIds(), "approval.result", p, true);
    }

    private Map<String, Object> requestPayload(ItmApproval a)
    {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("approvalId", a.getApprovalId());
        p.put("runId", a.getRunId());
        p.put("taskName", a.getTaskName());
        p.put("host", StringUtils.isNotEmpty(a.getHostName()) ? a.getHostName() : a.getHostId());
        p.put("command", a.getCommand());
        p.put("risk", a.getRisk());
        try
        {
            p.put("reasons", objectMapper.readValue(StringUtils.nvl(a.getReasons(), "[]"), List.class));
        }
        catch (Exception e)
        {
            p.put("reasons", List.of());
        }
        p.put("explanation", a.getExplanation());
        p.put("expiresAt", a.getExpiresAt().toInstant().toString());
        return p;
    }

    private List<Long> approverIds()
    {
        return approvalMapper.selectApproverUserIds();
    }

    private int expireMinutes()
    {
        try
        {
            int v = Integer.parseInt(StringUtils.nvl(configService.selectConfigByKey("itm.approval.expireMin"), "30").trim());
            return Math.min(Math.max(v, 1), 24 * 60);
        }
        catch (NumberFormatException e)
        {
            return 30;
        }
    }

    // ---------------------------------------------------------------- 长连接

    @Override
    public Set<String> types()
    {
        return Set.of("approval.decide");
    }

    @Override
    public void onMessage(ClientWsHandler.Peer peer, String type, Map<String, Object> payload)
    {
        SysUser user = userService.selectUserById(peer.userId());
        if (user == null)
        {
            return;
        }
        try
        {
            decide(str(payload.get("approvalId"), 64), str(payload.get("decision"), 16), str(payload.get("comment"), 500), user.getUserName(), permissionService.getMenuPermission(user));
        }
        catch (ApiException e)
        {
            log.info("设备 {} 的审批没有生效：{}", peer.deviceId(), e.getMessage());
        }
    }

    /** 审批人的设备上线：补发还没处理的审批 */
    @Override
    public void onConnected(ClientWsHandler.Peer peer)
    {
        if (!approverIds().contains(peer.userId()))
        {
            return;
        }
        Date now = new Date();
        for (ItmApproval a : pending())
        {
            if (a.getExpiresAt() != null && a.getExpiresAt().after(now))
            {
                ws.send(peer.deviceId(), "approval.request", requestPayload(a), true);
            }
        }
    }

    static String str(Object o, int max)
    {
        if (o == null)
        {
            return null;
        }
        String s = String.valueOf(o).trim();
        return s.length() > max ? s.substring(0, max) : s;
    }
}
