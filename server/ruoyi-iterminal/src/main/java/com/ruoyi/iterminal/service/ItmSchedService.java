package com.ruoyi.iterminal.service;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledFuture;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.scheduling.support.CronExpression;
import org.springframework.scheduling.support.CronTrigger;
import org.springframework.stereotype.Service;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ruoyi.common.exception.ServiceException;
import com.ruoyi.common.utils.StringUtils;
import com.ruoyi.iterminal.domain.ItmDevice;
import com.ruoyi.iterminal.domain.ItmSchedRun;
import com.ruoyi.iterminal.domain.ItmSchedTask;
import com.ruoyi.iterminal.mapper.ItmDeviceMapper;
import com.ruoyi.iterminal.mapper.ItmSchedRunMapper;
import com.ruoyi.iterminal.mapper.ItmSchedTaskMapper;
import com.ruoyi.iterminal.ws.ClientWsHandler;
import com.ruoyi.iterminal.ws.WsMessageListener;

/**
 * 定时任务（文档二 5.10）：按 cron 把任务派发到指定的客户端设备执行（task.dispatch），客户端回报进度和结果（task.progress / task.result）。
 * 设备不在线时记录为「设备离线」；超过超时时间 + 5 分钟还没有结果的记为超时。
 */
@Service
public class ItmSchedService implements WsMessageListener
{
    private static final Logger log = LoggerFactory.getLogger(ItmSchedService.class);
    private static final Set<String> TYPES = Set.of("COMMAND", "SKILL", "AGENT_PROMPT");
    private static final Set<String> CAPS = Set.of("READONLY", "APPROVE", "AUTO");
    private static final Set<String> FINAL = Set.of("SUCCESS", "PARTIAL", "FAILED", "TIMEOUT", "CANCELLED");

    @Autowired
    private ItmSchedTaskMapper taskMapper;

    @Autowired
    private ItmSchedRunMapper runMapper;

    @Autowired
    private ItmDeviceMapper deviceMapper;

    @Autowired
    private ItmNotifyService notifyService;

    @Autowired
    private ClientWsHandler ws;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    @Qualifier("itmScheduler")
    private ThreadPoolTaskScheduler scheduler;

    private final Map<Long, ScheduledFuture<?>> jobs = new ConcurrentHashMap<>();

    @PostConstruct
    public void init()
    {
        for (ItmSchedTask t : taskMapper.selectItmSchedTaskList(new ItmSchedTask()))
        {
            schedule(t);
        }
        scheduler.scheduleWithFixedDelay(this::checkTimeouts, Duration.ofSeconds(30));
    }

    // ---------------------------------------------------------------- 管理

    public List<ItmSchedTask> list(ItmSchedTask q)
    {
        return taskMapper.selectItmSchedTaskList(q);
    }

    public ItmSchedTask get(Long taskId)
    {
        return taskMapper.selectItmSchedTaskById(taskId);
    }

    public int insert(ItmSchedTask t)
    {
        validate(t);
        int n = taskMapper.insertItmSchedTask(t);
        schedule(taskMapper.selectItmSchedTaskById(t.getTaskId()));
        return n;
    }

    public int update(ItmSchedTask t)
    {
        validate(t);
        int n = taskMapper.updateItmSchedTask(t);
        schedule(taskMapper.selectItmSchedTaskById(t.getTaskId()));
        return n;
    }

    public int changeStatus(Long taskId, String status, String updateBy)
    {
        ItmSchedTask t = new ItmSchedTask();
        t.setTaskId(taskId);
        t.setStatus("0".equals(status) ? "0" : "1");
        t.setUpdateBy(updateBy);
        int n = taskMapper.updateItmSchedTask(t);
        schedule(taskMapper.selectItmSchedTaskById(taskId));
        return n;
    }

    public int delete(Long[] taskIds)
    {
        Arrays.stream(taskIds).forEach(this::unschedule);
        return taskMapper.deleteItmSchedTaskByIds(taskIds);
    }

    /** 立即执行一次 */
    public ItmSchedRun runNow(Long taskId)
    {
        ItmSchedTask t = taskMapper.selectItmSchedTaskById(taskId);
        if (t == null)
        {
            throw new ServiceException("任务不存在");
        }
        return dispatch(t, "MANUAL");
    }

    private void validate(ItmSchedTask t)
    {
        if (StringUtils.isEmpty(t.getTaskName()))
        {
            throw new ServiceException("请填写任务名称");
        }
        if (!TYPES.contains(t.getTaskType()))
        {
            throw new ServiceException("任务类型不正确");
        }
        if ("COMMAND".equals(t.getTaskType()) && StringUtils.isEmpty(t.getCommand()))
        {
            throw new ServiceException("请填写要执行的命令");
        }
        if ("AGENT_PROMPT".equals(t.getTaskType()) && StringUtils.isEmpty(t.getPrompt()))
        {
            throw new ServiceException("请填写交给 Agent 的任务描述");
        }
        if ("SKILL".equals(t.getTaskType()) && StringUtils.isEmpty(t.getSkill()))
        {
            throw new ServiceException("请填写 Skill 名称");
        }
        if (StringUtils.isNotEmpty(t.getSkillParams()))
        {
            try
            {
                objectMapper.readValue(t.getSkillParams(), Map.class);
            }
            catch (Exception e)
            {
                throw new ServiceException("Skill 参数需要是 JSON 对象，例如 {\"threshold\": 80}");
            }
        }
        if (StringUtils.isEmpty(t.getCronExpression()) || !CronExpression.isValidExpression(t.getCronExpression()))
        {
            throw new ServiceException("cron 表达式不正确（6 段：秒 分 时 日 月 周，例如 0 0 2 * * ?）");
        }
        if (t.getPermissionCap() != null && !CAPS.contains(t.getPermissionCap()))
        {
            throw new ServiceException("权限上限不正确");
        }
        if (hosts(t).isEmpty())
        {
            throw new ServiceException("请填写目标主机（设备上的主机名称或ID，每行一个）");
        }
        if (StringUtils.isEmpty(t.getDeviceId()) || deviceMapper.selectItmDeviceById(t.getDeviceId()) == null)
        {
            throw new ServiceException("请选择执行设备");
        }
        if (t.getTimeoutMin() != null && (t.getTimeoutMin() < 1 || t.getTimeoutMin() > 24 * 60))
        {
            throw new ServiceException("超时需要是 1–1440 分钟");
        }
    }

    private void schedule(ItmSchedTask t)
    {
        if (t == null)
        {
            return;
        }
        unschedule(t.getTaskId());
        if (!"0".equals(t.getStatus()) || !CronExpression.isValidExpression(t.getCronExpression()))
        {
            return;
        }
        Long id = t.getTaskId();
        jobs.put(id, scheduler.schedule(() -> {
            ItmSchedTask cur = taskMapper.selectItmSchedTaskById(id);
            if (cur != null && "0".equals(cur.getStatus()))
            {
                try
                {
                    dispatch(cur, "CRON");
                }
                catch (Exception e)
                {
                    log.warn("定时任务 {} 派发失败：{}", id, e.getMessage());
                }
            }
        }, new CronTrigger(t.getCronExpression())));
    }

    private void unschedule(Long taskId)
    {
        ScheduledFuture<?> f = jobs.remove(taskId);
        if (f != null)
        {
            f.cancel(false);
        }
    }

    // ---------------------------------------------------------------- 派发

    private ItmSchedRun dispatch(ItmSchedTask t, String trigger)
    {
        Date now = new Date();
        ItmSchedRun run = new ItmSchedRun();
        run.setRunId(UUID.randomUUID().toString());
        run.setTaskId(t.getTaskId());
        run.setTaskName(t.getTaskName());
        run.setTaskType(t.getTaskType());
        run.setDeviceId(t.getDeviceId());
        run.setTriggerType(trigger);
        run.setPercent(0);
        run.setStartedAt(now);
        ItmDevice device = deviceMapper.selectItmDeviceById(t.getDeviceId());
        boolean ok = device != null && "0".equals(device.getStatus()) && ws.send(t.getDeviceId(), "task.dispatch", dispatchPayload(t, run.getRunId()), true);
        if (ok)
        {
            run.setStatus("DISPATCHED");
        }
        else
        {
            run.setStatus("OFFLINE");
            run.setEndedAt(now);
            run.setSummary(device == null ? "执行设备不存在" : !"0".equals(device.getStatus()) ? "执行设备已被吊销" : "执行设备不在线，没有执行");
        }
        runMapper.insertItmSchedRun(run);
        if ("OFFLINE".equals(run.getStatus()))
        {
            notifyRun(run, "OFFLINE", run.getSummary());
        }
        ItmSchedTask upd = new ItmSchedTask();
        upd.setTaskId(t.getTaskId());
        upd.setLastRunAt(now);
        taskMapper.updateItmSchedTask(upd);
        return run;
    }

    private Map<String, Object> dispatchPayload(ItmSchedTask t, String runId)
    {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("runId", runId);
        p.put("taskId", String.valueOf(t.getTaskId()));
        p.put("taskName", t.getTaskName());
        p.put("type", t.getTaskType());
        if (StringUtils.isNotEmpty(t.getCommand()))
        {
            p.put("command", t.getCommand());
        }
        if (StringUtils.isNotEmpty(t.getPrompt()))
        {
            p.put("prompt", t.getPrompt());
        }
        if (StringUtils.isNotEmpty(t.getSkill()))
        {
            p.put("skill", t.getSkill());
        }
        if (StringUtils.isNotEmpty(t.getSkillParams()))
        {
            try
            {
                p.put("params", objectMapper.readValue(t.getSkillParams(), Map.class));
            }
            catch (Exception ignored)
            {
                // 保存时已经校验过
            }
        }
        // 主机按名称或客户端ID匹配（客户端先按服务端ID、再按本机ID、最后按名称找）
        List<Map<String, String>> hosts = new ArrayList<>();
        for (String h : hosts(t))
        {
            hosts.add(Map.of("id", h, "name", h));
        }
        p.put("hosts", hosts);
        p.put("permissionCap", StringUtils.nvl(t.getPermissionCap(), "READONLY"));
        p.put("timeoutMin", t.getTimeoutMin() == null ? 30 : t.getTimeoutMin());
        return p;
    }

    private static List<String> hosts(ItmSchedTask t)
    {
        List<String> out = new ArrayList<>();
        for (String s : StringUtils.nvl(t.getHosts(), "").split("[\\r\\n,，]+"))
        {
            String h = s.trim();
            if (!h.isEmpty() && !out.contains(h) && out.size() < 500)
            {
                out.add(h.length() > 200 ? h.substring(0, 200) : h);
            }
        }
        return out;
    }

    private void checkTimeouts()
    {
        try
        {
            long now = System.currentTimeMillis();
            for (ItmSchedRun r : runMapper.selectUnfinished())
            {
                ItmSchedTask t = taskMapper.selectItmSchedTaskById(r.getTaskId());
                int timeout = t == null || t.getTimeoutMin() == null ? 30 : t.getTimeoutMin();
                if (r.getStartedAt() != null && now - r.getStartedAt().getTime() > (timeout + 5) * 60_000L)
                {
                    ItmSchedRun upd = new ItmSchedRun();
                    upd.setRunId(r.getRunId());
                    upd.setStatus("TIMEOUT");
                    upd.setSummary("超过 " + timeout + " 分钟没有收到执行结果");
                    upd.setEndedAt(new Date());
                    runMapper.updateItmSchedRun(upd);
                    notifyRun(r, "TIMEOUT", upd.getSummary());
                }
            }
        }
        catch (Exception e)
        {
            log.warn("检查执行超时失败：{}", e.getMessage());
        }
    }

    // ---------------------------------------------------------------- 客户端回报

    @Override
    public Set<String> types()
    {
        return Set.of("task.progress", "task.result");
    }

    @Override
    public void onMessage(ClientWsHandler.Peer peer, String type, Map<String, Object> payload)
    {
        String runId = ItmApprovalService.str(payload.get("runId"), 64);
        ItmSchedRun run = runId == null ? null : runMapper.selectItmSchedRunById(runId);
        // 只接受执行这个任务的设备的回报；已经结束的（超时等）不再更新
        if (run == null || !peer.deviceId().equals(run.getDeviceId()) || FINAL.contains(run.getStatus()))
        {
            return;
        }
        ItmSchedRun upd = new ItmSchedRun();
        upd.setRunId(runId);
        if ("task.progress".equals(type))
        {
            upd.setStatus("RUNNING");
            Object pct = payload.get("percent");
            if (pct instanceof Number n)
            {
                upd.setPercent(Math.max(0, Math.min(100, n.intValue())));
            }
        }
        else
        {
            String status = ItmApprovalService.str(payload.get("status"), 16);
            upd.setStatus(FINAL.contains(status) ? status : "FAILED");
            upd.setPercent(100);
            upd.setSummary(StringUtils.substring(StringUtils.nvl(ItmApprovalService.str(payload.get("summary"), 8000), ""), 0, 8000));
            try
            {
                String hosts = objectMapper.writeValueAsString(payload.getOrDefault("hosts", List.of()));
                upd.setHosts(hosts.length() > 4_000_000 ? hosts.substring(0, 4_000_000) : hosts);
            }
            catch (Exception e)
            {
                upd.setHosts("[]");
            }
            upd.setEndedAt(new Date());
        }
        runMapper.updateItmSchedRun(upd);
        if (!"task.progress".equals(type))
        {
            notifyRun(run, upd.getStatus(), upd.getSummary());
        }
    }

    private static final Map<String, String> STATUS_LABEL = Map.of(
        "SUCCESS", "全部成功", "PARTIAL", "部分成功", "FAILED", "失败", "TIMEOUT", "超时", "OFFLINE", "设备离线，没有执行", "CANCELLED", "已取消");

    /** 执行结束：失败 / 部分成功 / 超时发 TASK_FAILED，设备离线发 TASK_OFFLINE，全部成功发 TASK_SUCCESS */
    private void notifyRun(ItmSchedRun run, String status, String summary)
    {
        String event = switch (status)
        {
            case "SUCCESS" -> ItmNotifyService.TASK_SUCCESS;
            case "OFFLINE" -> ItmNotifyService.TASK_OFFLINE;
            case "FAILED", "PARTIAL", "TIMEOUT" -> ItmNotifyService.TASK_FAILED;
            default -> null;
        };
        if (event == null)
        {
            return;
        }
        Map<String, String> f = new LinkedHashMap<>();
        f.put("任务", run.getTaskName());
        f.put("结果", STATUS_LABEL.getOrDefault(status, status));
        if (StringUtils.isNotEmpty(summary))
        {
            f.put("说明", StringUtils.substring(summary, 0, 500));
        }
        f.put("执行设备", notifyService.deviceLabel(run.getDeviceId()));
        f.put("触发方式", "MANUAL".equals(run.getTriggerType()) ? "手动执行" : "定时");
        String title = switch (status)
        {
            case "SUCCESS" -> "定时任务执行成功";
            case "OFFLINE" -> "定时任务没有执行（设备离线）";
            case "TIMEOUT" -> "定时任务执行超时";
            case "PARTIAL" -> "定时任务部分失败";
            default -> "定时任务执行失败";
        };
        notifyService.publish(event, title + "：" + run.getTaskName(), f, "/iterminal/run?taskId=" + run.getTaskId());
    }
}
