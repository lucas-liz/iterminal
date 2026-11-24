package com.ruoyi.iterminal.controller.admin;

import java.util.List;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.ruoyi.common.annotation.Log;
import com.ruoyi.common.core.controller.BaseController;
import com.ruoyi.common.core.domain.AjaxResult;
import com.ruoyi.common.core.page.TableDataInfo;
import com.ruoyi.common.enums.BusinessType;
import com.ruoyi.common.utils.StringUtils;
import com.ruoyi.iterminal.domain.ItmNotifyChannel;
import com.ruoyi.iterminal.domain.ItmNotifyLog;
import com.ruoyi.iterminal.mapper.ItmNotifyChannelMapper;
import com.ruoyi.iterminal.mapper.ItmNotifyLogMapper;
import com.ruoyi.iterminal.service.ItmNotifyService;

/**
 * 管理后台：通知渠道（钉钉 / 企业微信 / 飞书 / 邮件 / Webhook）和发送记录
 */
@RestController
@RequestMapping("/iterminal/notify")
public class NotifyController extends BaseController
{
    @Autowired
    private ItmNotifyChannelMapper channelMapper;

    @Autowired
    private ItmNotifyLogMapper logMapper;

    @Autowired
    private ItmNotifyService notifyService;

    @PreAuthorize("@ss.hasPermi('itm:notify:list')")
    @GetMapping("/channel/list")
    public TableDataInfo list(ItmNotifyChannel query)
    {
        startPage();
        List<ItmNotifyChannel> list = channelMapper.selectItmNotifyChannelList(query);
        list.forEach(ItmNotifyService::masked);
        return getDataTable(list);
    }

    @PreAuthorize("@ss.hasPermi('itm:notify:list')")
    @GetMapping("/channel/{channelId}")
    public AjaxResult getInfo(@PathVariable Long channelId)
    {
        return success(ItmNotifyService.masked(channelMapper.selectItmNotifyChannelById(channelId)));
    }

    @PreAuthorize("@ss.hasPermi('itm:notify:add')")
    @Log(title = "通知渠道", businessType = BusinessType.INSERT)
    @PostMapping("/channel")
    public AjaxResult add(@RequestBody ItmNotifyChannel ch)
    {
        ch.setChannelId(null);
        if (ItmNotifyService.isMaskedSecret(ch.getSecret()))
        {
            ch.setSecret("");
        }
        notifyService.validate(ch);
        ch.setCreateBy(getUsername());
        return toAjax(channelMapper.insertItmNotifyChannel(ch));
    }

    @PreAuthorize("@ss.hasPermi('itm:notify:edit')")
    @Log(title = "通知渠道", businessType = BusinessType.UPDATE)
    @PutMapping("/channel")
    public AjaxResult edit(@RequestBody ItmNotifyChannel ch)
    {
        // 密钥显示为 ****** 时表示没有修改
        if (ItmNotifyService.isMaskedSecret(ch.getSecret()))
        {
            ch.setSecret(null);
        }
        notifyService.validate(ch);
        ch.setUpdateBy(getUsername());
        return toAjax(channelMapper.updateItmNotifyChannel(ch));
    }

    @PreAuthorize("@ss.hasPermi('itm:notify:remove')")
    @Log(title = "通知渠道", businessType = BusinessType.DELETE)
    @DeleteMapping("/channel/{channelIds}")
    public AjaxResult remove(@PathVariable Long[] channelIds)
    {
        return toAjax(channelMapper.deleteItmNotifyChannelByIds(channelIds));
    }

    /** 发送测试消息：可以测试还没保存的配置（密钥显示为 ****** 时用已保存的） */
    @PreAuthorize("@ss.hasPermi('itm:notify:test')")
    @PostMapping("/channel/test")
    public AjaxResult test(@RequestBody ItmNotifyChannel ch)
    {
        if (ItmNotifyService.isMaskedSecret(ch.getSecret()) && ch.getChannelId() != null)
        {
            ItmNotifyChannel saved = channelMapper.selectItmNotifyChannelById(ch.getChannelId());
            ch.setSecret(saved == null ? "" : saved.getSecret());
        }
        if (StringUtils.isEmpty(ch.getEvents()))
        {
            ch.setEvents(ItmNotifyService.TASK_FAILED);
        }
        notifyService.validate(ch);
        if (ch.getChannelId() == null)
        {
            ch.setChannelId(0L);
        }
        String error = notifyService.test(ch);
        return error == null ? success("测试消息已发送") : error("发送失败：" + error);
    }

    @PreAuthorize("@ss.hasPermi('itm:notify:list')")
    @GetMapping("/log/list")
    public TableDataInfo logs(ItmNotifyLog query)
    {
        startPage();
        return getDataTable(logMapper.selectItmNotifyLogList(query));
    }
}
