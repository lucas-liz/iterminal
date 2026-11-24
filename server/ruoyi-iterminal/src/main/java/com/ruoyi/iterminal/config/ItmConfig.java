package com.ruoyi.iterminal.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

/**
 * iTerminal 模块的配置：独立的调度线程池（定时任务派发、审批过期、执行超时、WebSocket 重发和心跳检查），
 * 不使用若依的 Quartz，也不开启全局 @EnableScheduling，避免影响若依自带的定时任务。
 */
@Configuration
public class ItmConfig
{
    @Bean(name = "itmScheduler", destroyMethod = "shutdown")
    public ThreadPoolTaskScheduler itmScheduler()
    {
        ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(4);
        scheduler.setThreadNamePrefix("itm-sched-");
        scheduler.setRemoveOnCancelPolicy(true);
        scheduler.initialize();
        return scheduler;
    }
}
