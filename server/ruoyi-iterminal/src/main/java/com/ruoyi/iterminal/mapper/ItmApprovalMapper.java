package com.ruoyi.iterminal.mapper;

import java.util.Date;
import java.util.List;
import org.apache.ibatis.annotations.Param;
import com.ruoyi.iterminal.domain.ItmApproval;

/** 远程审批 */
public interface ItmApprovalMapper
{
    ItmApproval selectItmApprovalById(String approvalId);

    List<ItmApproval> selectItmApprovalList(ItmApproval query);

    int insertItmApproval(ItmApproval approval);

    /** 处理审批：只有待审批的才能改，返回 0 表示已经被别人处理或已过期 */
    int decide(@Param("approvalId") String approvalId, @Param("status") String status, @Param("decidedBy") String decidedBy, @Param("comment") String comment);

    /** 到期还没处理的审批 */
    List<ItmApproval> selectDue(@Param("now") Date now);

    /** 可以处理审批的用户（超级管理员，或者有 itm:approval:decide 权限的角色） */
    List<Long> selectApproverUserIds();

    /** 保留期限清理：删除早于 before 创建、已经处理或过期的审批 */
    int deleteBefore(@Param("before") Date before, @Param("limit") int limit);
}
