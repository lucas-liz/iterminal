package com.ruoyi.iterminal.mapper;

import java.util.List;
import org.apache.ibatis.annotations.Param;
import com.ruoyi.iterminal.domain.ItmLlmProvider;

/** 团队模型提供商 */
public interface ItmLlmProviderMapper
{
    List<ItmLlmProvider> selectItmLlmProviderList(ItmLlmProvider query);

    ItmLlmProvider selectItmLlmProviderById(Long providerId);

    int insertItmLlmProvider(ItmLlmProvider p);

    int updateItmLlmProvider(ItmLlmProvider p);

    /** 只更新 API Key 密文（新增时拿到 ID 之后再加密） */
    int updateApiKey(@Param("providerId") Long providerId, @Param("apiKeyEnc") String apiKeyEnc);

    int deleteItmLlmProviderByIds(Long[] providerIds);
}
