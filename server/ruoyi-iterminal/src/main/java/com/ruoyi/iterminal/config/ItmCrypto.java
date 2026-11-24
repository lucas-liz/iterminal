package com.ruoyi.iterminal.config;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import com.ruoyi.common.utils.StringUtils;

/**
 * 服务端保存的敏感字段（团队模型的 API Key、团队主机的密码 / 私钥）用 AES-256-GCM 加密。
 * 密钥 = SHA-256(ITM_DATA_KEY)；没有设置 ITM_DATA_KEY 时用 JWT 密钥（TOKEN_SECRET）派生。
 * 注意：换了密钥之后，已经保存的密文就解不开了，需要重新填写。
 * 密文格式：v1:base64(iv(12) | 密文 | tag(16))，aad 绑定字段身份（例如 llm:100）。
 */
@Component
public class ItmCrypto
{
    private static final SecureRandom RANDOM = new SecureRandom();

    private final SecretKeySpec key;

    public ItmCrypto(@Value("${itm.data-key:}") String dataKey, @Value("${token.secret}") String tokenSecret)
    {
        String material = StringUtils.isNotEmpty(dataKey) ? "itm-data-key:" + dataKey : "itm-token-secret:" + tokenSecret;
        try
        {
            this.key = new SecretKeySpec(MessageDigest.getInstance("SHA-256").digest(material.getBytes(StandardCharsets.UTF_8)), "AES");
        }
        catch (Exception e)
        {
            throw new IllegalStateException(e);
        }
    }

    public String encrypt(String plain, String aad)
    {
        if (StringUtils.isEmpty(plain))
        {
            return "";
        }
        try
        {
            byte[] iv = new byte[12];
            RANDOM.nextBytes(iv);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
            c.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
            byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ct, 0, out, iv.length, ct.length);
            return "v1:" + Base64.getEncoder().encodeToString(out);
        }
        catch (Exception e)
        {
            throw new IllegalStateException("加密失败：" + e.getMessage());
        }
    }

    /** 解密；空串返回空串，解不开时抛出带说明的异常 */
    public String decrypt(String enc, String aad)
    {
        if (StringUtils.isEmpty(enc))
        {
            return "";
        }
        try
        {
            if (!enc.startsWith("v1:"))
            {
                throw new IllegalArgumentException("格式不正确");
            }
            byte[] all = Base64.getDecoder().decode(enc.substring(3));
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, all, 0, 12));
            c.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
            return new String(c.doFinal(all, 12, all.length - 12), StandardCharsets.UTF_8);
        }
        catch (Exception e)
        {
            throw new IllegalStateException("保存的密钥解不开（服务端的 ITM_DATA_KEY / TOKEN_SECRET 可能换过），请重新填写");
        }
    }
}
